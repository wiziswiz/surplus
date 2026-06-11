// Prevents an extra console window on Windows; harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Surplus menu-bar shell.
//!
//! Pure viewer: the launchd-managed `surplus board` server (localhost) owns
//! all state. This app polls /api/state for the tray title + menu lines,
//! polls /api/events for notifications, and opens the board in a webview
//! window. If the server is unreachable the tray says so — launchd will
//! resurrect it.

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
    #[serde(rename = "planName")]
    plan_name: Option<String>,
    unavailable: bool,
}

#[derive(Deserialize, Default, Clone)]
struct Decision {
    action: String,
    reason: String,
}

#[derive(Deserialize, Default)]
struct ApiState {
    usage: serde_json::Map<String, serde_json::Value>,
    decisions: serde_json::Map<String, serde_json::Value>,
    paused: bool,
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
    last_event_id: u64,
    tray: TrayIcon,
    line_claude: MenuItem<tauri::Wry>,
    line_codex: MenuItem<tauri::Wry>,
    line_decision: MenuItem<tauri::Wry>,
    item_pause: MenuItem<tauri::Wry>,
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
    ureq::post(url)
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .send_string("{}")
        .is_ok()
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

fn provider_line(name: &str, u: &Usage) -> String {
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

/// Compact menu-bar title. Weekly utilization is the burn-relevant number.
fn tray_title(paused: bool, burning: bool, weekly: Option<f64>, reachable: bool) -> String {
    if !reachable {
        return "surplus ⌁".into();
    }
    if paused {
        return "⏸ surplus".into();
    }
    let w = pct(weekly);
    if burning {
        format!("🔥 {w}")
    } else {
        format!("◔ {w}")
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
            let _ = s.tray.set_title(Some(tray_title(false, false, None, false)));
            let _ = s.line_decision.set_text("server unreachable — launchd will restart it");
        }
        Some(st) => {
            s.paused = st.paused;

            let parse_usage = |key: &str| -> Option<Usage> {
                st.usage
                    .get(key)
                    .and_then(|v| serde_json::from_value::<Usage>(v.clone()).ok())
            };
            let parse_decision = |key: &str| -> Option<Decision> {
                st.decisions
                    .get(key)
                    .and_then(|v| serde_json::from_value::<Decision>(v.clone()).ok())
            };

            let claude = parse_usage("claude");
            let codex = parse_usage("codex");
            let d_claude = parse_decision("claude");
            let d_codex = parse_decision("codex");

            let burning = [&d_claude, &d_codex]
                .iter()
                .any(|d| d.as_ref().map(|d| d.action == "burn").unwrap_or(false));
            let weekly = claude.as_ref().and_then(|u| u.seven_day_pct);

            let _ = s
                .tray
                .set_title(Some(tray_title(st.paused, burning, weekly, true)));

            match &claude {
                Some(u) => {
                    let _ = s.line_claude.set_text(provider_line("claude", u));
                }
                None => {
                    let _ = s.line_claude.set_text("claude · disabled");
                }
            }
            match &codex {
                Some(u) => {
                    let _ = s.line_codex.set_text(provider_line("codex", u));
                }
                None => {
                    let _ = s.line_codex.set_text("codex · disabled");
                }
            }

            let decision_text = d_claude
                .or(d_codex)
                .map(|d| d.reason)
                .unwrap_or_else(|| "no decision".into());
            let _ = s.line_decision.set_text(truncate(&decision_text, 70));
            let _ = s
                .item_pause
                .set_text(if st.paused { "Resume burning" } else { "Pause" });
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
                data["provider"].as_str().unwrap_or("?"),
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

fn open_board(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("board") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let port = app.state::<State>().0.lock().unwrap().port;
    let url: tauri::Url = api(port, "/").parse().expect("valid board url");
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

            let line_claude = MenuItemBuilder::with_id("line-claude", "claude · …")
                .enabled(false)
                .build(app)?;
            let line_codex = MenuItemBuilder::with_id("line-codex", "codex · …")
                .enabled(false)
                .build(app)?;
            let line_decision = MenuItemBuilder::with_id("line-decision", "connecting…")
                .enabled(false)
                .build(app)?;
            let item_open = MenuItemBuilder::with_id("open", "Open Board").build(app)?;
            let item_burn = MenuItemBuilder::with_id("burn", "Burn now").build(app)?;
            let item_pause = MenuItemBuilder::with_id("pause", "Pause").build(app)?;
            let item_refresh = MenuItemBuilder::with_id("refresh", "Refresh usage").build(app)?;
            let item_quit = MenuItemBuilder::with_id("quit", "Quit Surplus").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&line_claude)
                .item(&line_codex)
                .item(&line_decision)
                .separator()
                .item(&item_open)
                .item(&item_burn)
                .item(&item_pause)
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
                        "open" => open_board(app),
                        "burn" => {
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
                last_event_id,
                tray,
                line_claude,
                line_codex,
                line_decision,
                item_pause,
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
