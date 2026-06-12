// Prevents an extra console window on Windows; harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Surplus menu-bar shell.
//!
//! Pure viewer: the launchd-managed `surplus board` server (localhost) owns
//! all state. This app polls /api/state for the tray title + menu lines,
//! polls /api/events for notifications, and opens the board in a webview
//! window. If the server is unreachable the tray says so — launchd will
//! resurrect it.
//!
//! Multi-account: /api/state keys `usage`/`decisions` by ACCOUNT KEY
//! ('claude' for the main account, 'claude:<id>' for extra claude accounts,
//! 'codex') and lists configured accounts in `accounts[]`. One disabled menu
//! line is created per account at startup.

use serde::Deserialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

const POLL_SECS: u64 = 30;
const HTTP_TIMEOUT_SECS: u64 = 5;

// ---------------------------------------------------------------------------
// Server API types (subset of the board contract)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default, Clone)]
struct Usage {
    #[serde(rename = "fiveHourPct")]
    five_hour_pct: Option<f64>,
    #[serde(rename = "sevenDayPct")]
    seven_day_pct: Option<f64>,
    /// ISO-8601 UTC string (JSON-serialized Date). Same fixed format for every
    /// account, so lexicographic order == chronological order.
    #[serde(rename = "sevenDayResetsAt")]
    seven_day_resets_at: Option<String>,
    #[serde(rename = "planName")]
    plan_name: Option<String>,
    unavailable: bool,
}

#[derive(Deserialize, Default, Clone)]
struct Decision {
    action: String,
    reason: String,
}

/// One configured burnable account, e.g. {key:'claude:work', provider:'claude',
/// label:'work'}. `priority` also comes over the wire but the tray ignores it.
#[derive(Deserialize, Clone)]
struct AccountInfo {
    key: String,
    provider: String,
    #[serde(default)]
    label: String,
}

#[derive(Deserialize, Default)]
struct ApiState {
    /// Keyed by account key ('claude' | 'claude:<id>' | 'codex').
    usage: serde_json::Map<String, serde_json::Value>,
    /// Keyed by account key, same grammar as `usage`.
    decisions: serde_json::Map<String, serde_json::Value>,
    /// Configured accounts in server order (claude accounts first, then codex).
    /// Absent on pre-multi-account servers — defaults to empty.
    #[serde(default)]
    accounts: Vec<AccountInfo>,
    paused: bool,
    #[serde(default)]
    armed: bool,
}

#[derive(Deserialize)]
struct EventRow {
    id: u64,
    #[serde(rename = "type")]
    kind: String,
    data: String,
}

// ---------------------------------------------------------------------------
// Shared app state
// ---------------------------------------------------------------------------

struct Shared {
    port: u16,
    paused: bool,
    armed: bool,
    last_event_id: u64,
    tray: TrayIcon,
    /// One disabled menu line per account: (account key, display name, item).
    /// Built once at startup from /api/state; accounts added to the config
    /// later appear after an app relaunch (acceptable for a tray viewer —
    /// tauri menus are easiest to treat as static after build).
    account_lines: Vec<(String, String, MenuItem<tauri::Wry>)>,
    line_decision: MenuItem<tauri::Wry>,
    item_pause: MenuItem<tauri::Wry>,
    item_arm: MenuItem<tauri::Wry>,
}

struct State(Mutex<Shared>);

fn board_port() -> u16 {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = format!("{home}/.surplus/config.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.pointer("/board/port").and_then(|p| p.as_u64()))
        .map(|p| p as u16)
        .unwrap_or(4242)
}

fn api(port: u16, path: &str) -> String {
    format!("http://localhost:{port}{path}")
}

fn get_json<T: serde::de::DeserializeOwned>(url: &str) -> Option<T> {
    ureq::get(url)
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .call()
        .ok()?
        .into_json::<T>()
        .ok()
}

fn post(url: &str) -> bool {
    post_body(url, "{}")
}

fn post_body(url: &str, body: &str) -> bool {
    ureq::post(url)
        .set("content-type", "application/json")
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .send_string(body)
        .is_ok()
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// Menu display name: 'claude personal', 'claude work', or just 'codex' when
/// the label adds nothing over the provider name.
fn display_name(a: &AccountInfo) -> String {
    if a.label.is_empty() || a.label == a.provider {
        a.provider.clone()
    } else {
        format!("{} {}", a.provider, a.label)
    }
}

/// Used when the server is unreachable at startup or predates accounts[]:
/// the classic single-claude + codex pair (keys match the legacy contract).
fn fallback_accounts() -> Vec<AccountInfo> {
    vec![
        AccountInfo {
            key: "claude".into(),
            provider: "claude".into(),
            label: String::new(),
        },
        AccountInfo {
            key: "codex".into(),
            provider: "codex".into(),
            label: String::new(),
        },
    ]
}

/// Per-account snapshot assembled from one /api/state poll.
struct AcctSnap {
    key: String,
    provider: String,
    usage: Option<Usage>,
    decision: Option<Decision>,
}

fn is_burning(a: &AcctSnap) -> bool {
    a.decision
        .as_ref()
        .map(|d| d.action == "burn")
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

fn pct(v: Option<f64>) -> String {
    match v {
        Some(n) => format!("{}%", n.round() as i64),
        None => "—".into(),
    }
}

fn account_line(name: &str, u: &Usage) -> String {
    if u.unavailable {
        return format!("{name} · usage unavailable");
    }
    let plan = u.plan_name.clone().unwrap_or_default();
    let plan = if plan.is_empty() { String::new() } else { format!(" {plan}") };
    format!(
        "{name}{plan} · 5h {} · 7d {}",
        pct(u.five_hour_pct),
        pct(u.seven_day_pct)
    )
}

/// Thin count marker for multi-account setups: '²' for two claude accounts.
/// Config caps claude accounts at 6, so single digits suffice (multi-digit
/// counts still render correctly digit-by-digit).
fn superscript_count(n: usize) -> String {
    if n < 2 {
        return String::new();
    }
    const DIGITS: [char; 10] = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
    n.to_string()
        .chars()
        .map(|c| DIGITS[(c as usize) - ('0' as usize)])
        .collect()
}

/// Compact menu-bar title. Weekly utilization is the burn-relevant number
/// (taken from the burning claude account, else the soonest-resetting one).
/// Hollow ring = disarmed (scheduler not installed), filled = armed. With
/// more than one claude account a superscript count is appended: '◔ 62% ²'.
fn tray_title(
    paused: bool,
    armed: bool,
    burning: bool,
    weekly: Option<f64>,
    reachable: bool,
    claude_count: usize,
) -> String {
    if !reachable {
        return "surplus ⌁".into();
    }
    if paused {
        return "⏸ surplus".into();
    }
    let w = pct(weekly);
    let marker = superscript_count(claude_count);
    let suffix = if marker.is_empty() { String::new() } else { format!(" {marker}") };
    if burning {
        format!("🔥 {w}{suffix}")
    } else if armed {
        format!("◔ {w}{suffix}")
    } else {
        format!("◌ {w}{suffix}")
    }
}

// ---------------------------------------------------------------------------
// Poll cycle: refresh tray + menu, emit notifications
// ---------------------------------------------------------------------------

fn refresh(app: &AppHandle, fresh: bool) {
    let state = app.state::<State>();
    let port = state.0.lock().unwrap().port;

    let url = if fresh {
        api(port, "/api/state?fresh=1")
    } else {
        api(port, "/api/state")
    };
    let api_state: Option<ApiState> = get_json(&url);

    let mut s = state.0.lock().unwrap();
    match api_state {
        None => {
            let _ = s
                .tray
                .set_title(Some(tray_title(false, false, false, None, false, 1)));
            let _ = s.line_decision.set_text("server unreachable — launchd will restart it");
        }
        Some(st) => {
            s.paused = st.paused;
            s.armed = st.armed;

            // Accounts come fresh on every poll; the title/count always
            // reflect the live config even though menu lines are static.
            let accounts = if st.accounts.is_empty() {
                fallback_accounts()
            } else {
                st.accounts.clone()
            };
            let snaps: Vec<AcctSnap> = accounts
                .iter()
                .map(|a| AcctSnap {
                    key: a.key.clone(),
                    provider: a.provider.clone(),
                    usage: st
                        .usage
                        .get(&a.key)
                        .and_then(|v| serde_json::from_value::<Usage>(v.clone()).ok()),
                    decision: st
                        .decisions
                        .get(&a.key)
                        .and_then(|v| serde_json::from_value::<Decision>(v.clone()).ok()),
                })
                .collect();

            // Flame when ANY account is burning (claude or codex).
            let burning = snaps.iter().any(is_burning);

            // Title account: among claude accounts, prefer a burning one,
            // else the one with the SOONEST 7-day reset (ISO strings compare
            // chronologically), else the first configured claude account.
            let claude_snaps: Vec<&AcctSnap> =
                snaps.iter().filter(|a| a.provider == "claude").collect();
            let reset_of = |a: &AcctSnap| -> Option<String> {
                a.usage.as_ref().and_then(|u| u.seven_day_resets_at.clone())
            };
            let title_acct: Option<&AcctSnap> = claude_snaps
                .iter()
                .find(|a| is_burning(a))
                .copied()
                .or_else(|| {
                    claude_snaps
                        .iter()
                        .filter(|a| reset_of(a).is_some())
                        .min_by(|x, y| reset_of(x).cmp(&reset_of(y)))
                        .copied()
                })
                .or_else(|| claude_snaps.first().copied());
            let weekly = title_acct
                .and_then(|a| a.usage.as_ref())
                .and_then(|u| u.seven_day_pct);

            let _ = s.tray.set_title(Some(tray_title(
                st.paused,
                st.armed,
                burning,
                weekly,
                true,
                claude_snaps.len(),
            )));

            // Update each account line by key. Lines for accounts removed
            // from the config keep their last text until relaunch; new
            // accounts have no line until relaunch (see Shared.account_lines).
            for (key, display, item) in &s.account_lines {
                match snaps
                    .iter()
                    .find(|a| &a.key == key)
                    .and_then(|a| a.usage.as_ref())
                {
                    Some(u) => {
                        let _ = item.set_text(account_line(display, u));
                    }
                    None => {
                        let _ = item.set_text(format!("{display} · disabled"));
                    }
                }
            }

            // Decision line: the burning account's reason wins, else the
            // title account's, else the first account with any decision.
            let decision_text = snaps
                .iter()
                .find(|a| is_burning(a))
                .and_then(|a| a.decision.as_ref())
                .or_else(|| title_acct.and_then(|a| a.decision.as_ref()))
                .or_else(|| snaps.iter().find_map(|a| a.decision.as_ref()))
                .map(|d| d.reason.clone())
                .unwrap_or_else(|| "no decision".into());
            let _ = s.line_decision.set_text(truncate(&decision_text, 70));
            let _ = s
                .item_pause
                .set_text(if st.paused { "Resume burning" } else { "Pause" });
            let _ = s.item_arm.set_text(if st.armed {
                "Disarm schedule"
            } else {
                "Arm schedule"
            });
        }
    }

    // Notifications from the event feed (cursor-based; never replays history).
    let after = s.last_event_id;
    drop(s);
    let events: Option<Vec<EventRow>> =
        get_json(&api(port, &format!("/api/events/poll?after={after}")));
    if let Some(rows) = events {
        let mut max_id = after;
        for row in &rows {
            if row.id > max_id {
                max_id = row.id;
            }
            notify_for(app, row);
        }
        app.state::<State>().0.lock().unwrap().last_event_id = max_id;
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let cut: String = text.chars().take(max - 1).collect();
        format!("{cut}…")
    }
}

fn notify_for(app: &AppHandle, row: &EventRow) {
    let data: serde_json::Value = serde_json::from_str(&row.data).unwrap_or_default();
    let (title, body): (String, String) = match row.kind.as_str() {
        "run-started" => (
            "Surplus is burning".into(),
            format!(
                "Run started on {} ({}/{})",
                // 'account' (e.g. 'claude:work') is additive; older servers
                // only send 'provider'.
                data["account"]
                    .as_str()
                    .or_else(|| data["provider"].as_str())
                    .unwrap_or("?"),
                data["model"].as_str().unwrap_or("?"),
                data["effort"].as_str().unwrap_or("?")
            ),
        ),
        "judge-verdict" => {
            let score = data["score"].as_i64().unwrap_or(0);
            (
                format!("Judge: {score}/5"),
                if score >= 4 {
                    "Task passed — branch ready for review.".into()
                } else {
                    "Below pass — requeued with feedback.".into()
                },
            )
        }
        "status-changed" => {
            let to = data["to"].as_str().unwrap_or("");
            match to {
                "blocked" => (
                    "Task blocked".into(),
                    "A task hit its attempt limit and needs you.".into(),
                ),
                "done" => ("Task done".into(), "Judge-passed and moved to Done.".into()),
                _ => return,
            }
        }
        _ => return,
    };
    let _ = app.notification().builder().title(title).body(body).show();
}

// ---------------------------------------------------------------------------
// Window + actions
// ---------------------------------------------------------------------------

fn open_board(app: &AppHandle, settings: bool) {
    let port = app.state::<State>().0.lock().unwrap().port;
    let path = if settings { "/?settings=1" } else { "/" };
    if let Some(mut w) = app.get_webview_window("board") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if settings {
            // Full navigation: the board reads ?settings=1 on mount and opens
            // the settings panel.
            if let Ok(url) = api(port, path).parse::<tauri::Url>() {
                let _ = w.navigate(url);
            }
        }
        return;
    }
    let url: tauri::Url = api(port, path).parse().expect("valid board url");
    let _ = WebviewWindowBuilder::new(app, "board", WebviewUrl::External(url))
        .title("Surplus")
        .inner_size(1320.0, 880.0)
        .build();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let port = board_port();

            // Discover configured accounts once at startup and build one
            // disabled menu line per account. Accounts added to the config
            // later only get a line after the app is relaunched (refresh()
            // updates existing lines by key but never adds menu items).
            let boot: Option<ApiState> = get_json(&api(port, "/api/state"));
            let boot_accounts = boot
                .as_ref()
                .map(|st| st.accounts.clone())
                .filter(|a| !a.is_empty())
                .unwrap_or_else(fallback_accounts);

            let mut account_lines: Vec<(String, String, MenuItem<tauri::Wry>)> = Vec::new();
            for (i, acct) in boot_accounts.iter().enumerate() {
                let display = display_name(acct);
                let item = MenuItemBuilder::with_id(
                    format!("line-account-{i}"),
                    format!("{display} · …"),
                )
                .enabled(false)
                .build(app)?;
                account_lines.push((acct.key.clone(), display, item));
            }

            let line_decision = MenuItemBuilder::with_id("line-decision", "connecting…")
                .enabled(false)
                .build(app)?;
            let item_open = MenuItemBuilder::with_id("open", "Open Board").build(app)?;
            let item_settings = MenuItemBuilder::with_id("settings", "Settings…").build(app)?;
            let item_burn = MenuItemBuilder::with_id("burn", "Burn now").build(app)?;
            let item_pause = MenuItemBuilder::with_id("pause", "Pause").build(app)?;
            let item_arm = MenuItemBuilder::with_id("arm", "Arm schedule").build(app)?;
            let item_refresh = MenuItemBuilder::with_id("refresh", "Refresh usage").build(app)?;
            let item_quit = MenuItemBuilder::with_id("quit", "Quit Surplus").build(app)?;

            let mut menu_builder = MenuBuilder::new(app);
            for (_, _, item) in &account_lines {
                menu_builder = menu_builder.item(item);
            }
            let menu = menu_builder
                .item(&line_decision)
                .separator()
                .item(&item_open)
                .item(&item_settings)
                .item(&item_burn)
                .item(&item_pause)
                .item(&item_arm)
                .item(&item_refresh)
                .separator()
                .item(&item_quit)
                .build()?;

            let tray = tauri::tray::TrayIconBuilder::with_id("surplus")
                .title("◔ …")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let port = app.state::<State>().0.lock().unwrap().port;
                    match event.id().as_ref() {
                        "open" => open_board(app, false),
                        "settings" => open_board(app, true),
                        "burn" => {
                            // Provider-agnostic: empty body lets the server
                            // pick the best account in AUTO burn order.
                            let ok = post(&api(port, "/api/burn"));
                            let _ = app
                                .notification()
                                .builder()
                                .title(if ok { "Burn requested" } else { "Burn failed" })
                                .body(if ok {
                                    "Dispatching the next ready task."
                                } else {
                                    "Could not reach the surplus server."
                                })
                                .show();
                            refresh(app, false);
                        }
                        "pause" => {
                            let paused = app.state::<State>().0.lock().unwrap().paused;
                            let path = if paused { "/api/resume" } else { "/api/pause" };
                            let _ = post(&api(port, path));
                            refresh(app, false);
                        }
                        "arm" => {
                            let armed = app.state::<State>().0.lock().unwrap().armed;
                            let body = format!("{{\"armed\": {}}}", !armed);
                            let ok = post_body(&api(port, "/api/scheduler"), &body);
                            let _ = app
                                .notification()
                                .builder()
                                .title(if !armed { "Scheduler armed" } else { "Scheduler disarmed" })
                                .body(if !ok {
                                    "Could not reach the surplus server."
                                } else if !armed {
                                    "surplus now checks usage every 15 min and burns in pre-reset windows."
                                } else {
                                    "Automatic burning is off. Manual Burn now still works."
                                })
                                .show();
                            refresh(app, false);
                        }
                        "refresh" => refresh(app, true),
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;

            // Initialize the event cursor to "now" so we never replay history.
            let last_event_id = get_json::<Vec<EventRow>>(&api(port, "/api/events/poll?after=0"))
                .map(|rows| rows.iter().map(|r| r.id).max().unwrap_or(0))
                .unwrap_or(0);

            app.manage(State(Mutex::new(Shared {
                port,
                paused: false,
                armed: false,
                last_event_id,
                tray,
                account_lines,
                line_decision,
                item_pause,
                item_arm,
            })));

            // First paint + poll loop.
            let handle = app.handle().clone();
            refresh(&handle, false);
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(POLL_SECS));
                refresh(&handle, false);
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building surplus menu-bar app")
        .run(|_app, event| {
            // Closing the board window must not quit a tray app; explicit
            // Quit (app.exit(0)) carries an exit code and is allowed through.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
