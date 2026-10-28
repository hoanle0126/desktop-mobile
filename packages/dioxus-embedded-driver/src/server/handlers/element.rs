//! Element-related WebDriver handlers.
//!
//! All DOM operations are implemented via JavaScript execution through the
//! bridge IPC channel. Elements are stored as global JS variable references
//! (`__wdio_elem_<N>`) and mapped to WebDriver element IDs in the session's
//! `ElementStore`.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::server::response::{WebDriverErrorResponse, WebDriverResponse, WebDriverResult};
use crate::server::AppState;
use crate::webdriver::element::ELEMENT_KEY;

/// Run a script and return its result, or a WebDriver error.
async fn eval(script: String, timeout_ms: u64) -> Result<Value, WebDriverErrorResponse> {
  let (tx, rx) = oneshot::channel();
  let id = Uuid::new_v4().to_string();
  wdio_dioxus_bridge::embedded::push(id, script, vec![], tx);
  match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
    Ok(Ok(Ok(v))) => Ok(v),
    Ok(Ok(Err(e))) => Err(WebDriverErrorResponse::javascript_error(&e, None)),
    Ok(Err(_)) => Err(WebDriverErrorResponse::unknown_error("eval channel closed")),
    Err(_) => Err(WebDriverErrorResponse::script_timeout()),
  }
}

/// Like `eval`, but prepends a JS staleness guard for `window.{var}`. If the
/// guard fires (the JS context was reset by a page reload), returns
/// `stale_element_reference` instead of `javascript_error`.
async fn eval_for_element(
  var: &str,
  script: String,
  timeout_ms: u64,
) -> Result<Value, WebDriverErrorResponse> {
  let guarded = format!(
    "if (typeof window.{var} === 'undefined' || window.{var} === null) throw '__wdio_stale__'; {script}"
  );
  match eval(guarded, timeout_ms).await {
    Err(e) if e.message == "__wdio_stale__" => {
      Err(WebDriverErrorResponse::stale_element_reference())
    }
    other => other,
  }
}

fn js_locator(using: &str, value: &str) -> String {
  match using {
    "css selector" => format!("document.querySelector({value:?})"),
    "xpath" => format!(
      "document.evaluate({value:?}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue"
    ),
    "link text" => format!(
      "(function(){{ for(var a of document.querySelectorAll('a')) {{ if(a.textContent.trim()==={value:?}) return a; }} return null; }})()"
    ),
    "partial link text" => format!(
      "(function(){{ for(var a of document.querySelectorAll('a')) {{ if(a.textContent.includes({value:?})) return a; }} return null; }})()"
    ),
    "tag name" => format!("document.getElementsByTagName({value:?})[0] ?? null"),
    _ => format!("document.querySelector({value:?})"),
  }
}

fn js_locator_all(using: &str, value: &str) -> String {
  match using {
    "css selector" => format!("Array.from(document.querySelectorAll({value:?}))"),
    "xpath" => format!(
      "(function(){{ var res = document.evaluate({value:?}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); var arr=[]; for(var i=0;i<res.snapshotLength;i++) arr.push(res.snapshotItem(i)); return arr; }})()"
    ),
    "link text" => format!(
      "Array.from(document.querySelectorAll('a')).filter(function(a){{ return a.textContent.trim()==={value:?}; }})"
    ),
    "partial link text" => format!(
      "Array.from(document.querySelectorAll('a')).filter(function(a){{ return a.textContent.includes({value:?}); }})"
    ),
    "tag name" => format!("Array.from(document.getElementsByTagName({value:?}))"),
    _ => format!("Array.from(document.querySelectorAll({value:?}))"),
  }
}

#[derive(Debug, Deserialize)]
pub struct FindElementRequest {
  pub using: String,
  pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct SendKeysRequest {
  pub text: String,
}

async fn session_timeout(
  state: &Arc<AppState>,
  session_id: &str,
) -> Result<u64, WebDriverErrorResponse> {
  let sessions = state.sessions.read().await;
  Ok(sessions.get(session_id)?.timeouts.script_ms)
}

/// POST `/session/{session_id}/element`
pub async fn find(
  State(state): State<Arc<AppState>>,
  Path(session_id): Path<String>,
  Json(req): Json<FindElementRequest>,
) -> WebDriverResult {
  let (script_timeout, implicit_ms) = {
    let sessions = state.sessions.read().await;
    let t = &sessions.get(&session_id)?.timeouts;
    (t.script_ms, t.implicit_ms)
  };
  let var = format!("__wdio_elem_{}", Uuid::new_v4().simple());
  let script = format!(
    "window.{var} = {}; return window.{var} !== null && window.{var} !== undefined ? '{}' : null",
    js_locator(&req.using, &req.value),
    var
  );
  let deadline = tokio::time::Instant::now() + Duration::from_millis(implicit_ms);
  loop {
    let result = eval(script.clone(), script_timeout).await?;
    match result.as_str() {
      Some(v) if !v.is_empty() => {
        let mut sessions = state.sessions.write().await;
        let session = sessions.get_mut(&session_id)?;
        let elem_id = session.elements.insert(v.to_string());
        return Ok(WebDriverResponse::success(json!({ ELEMENT_KEY: elem_id })));
      }
      _ => {
        if tokio::time::Instant::now() >= deadline {
          return Err(WebDriverErrorResponse::no_such_element());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
      }
    }
  }
}

/// POST `/session/{session_id}/elements`
pub async fn find_all(
  State(state): State<Arc<AppState>>,
  Path(session_id): Path<String>,
  Json(req): Json<FindElementRequest>,
) -> WebDriverResult {
  let (script_timeout, implicit_ms) = {
    let sessions = state.sessions.read().await;
    let t = &sessions.get(&session_id)?.timeouts;
    (t.script_ms, t.implicit_ms)
  };
  let prefix = Uuid::new_v4().simple().to_string();
  let locator = js_locator_all(&req.using, &req.value);
  let script = format!(
    "return (function(){{ var elems = {locator}; var vars = []; for(var i=0;i<elems.length;i++) {{ var k='__wdio_elem_{prefix}_'+i; window[k]=elems[i]; vars.push(k); }} return vars; }})()"
  );
  let deadline = tokio::time::Instant::now() + Duration::from_millis(implicit_ms);
  loop {
    let result = eval(script.clone(), script_timeout).await?;
    let vars: Vec<String> = result
      .as_array()
      .cloned()
      .unwrap_or_default()
      .into_iter()
      .filter_map(|v| v.as_str().map(str::to_string))
      .collect();
    if !vars.is_empty() || tokio::time::Instant::now() >= deadline {
      let mut sessions = state.sessions.write().await;
      let session = sessions.get_mut(&session_id)?;
      let refs: Vec<Value> = vars
        .into_iter()
        .map(|var| {
          let id = session.elements.insert(var);
          json!({ ELEMENT_KEY: id })
        })
        .collect();
      return Ok(WebDriverResponse::success(refs));
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
  }
}

/// GET `/session/{session_id}/element/active`
pub async fn get_active(
  State(state): State<Arc<AppState>>,
  Path(session_id): Path<String>,
) -> WebDriverResult {
  let timeout = session_timeout(&state, &session_id).await?;
  let var = format!("__wdio_active_{}", Uuid::new_v4().simple());
  let script = format!("window.{var} = document.activeElement; return '{var}'");
  let result = eval(script, timeout).await?;
  match result.as_str() {
    Some(v) => {
      let mut sessions = state.sessions.write().await;
      let session = sessions.get_mut(&session_id)?;
      let id = session.elements.insert(v.to_string());
      Ok(WebDriverResponse::success(json!({ ELEMENT_KEY: id })))
    }
    None => Err(WebDriverErrorResponse::no_such_element()),
  }
}

/// POST `/session/{session_id}/element/{element_id}/element`
pub async fn find_from_element(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id)): Path<(String, String)>,
  Json(req): Json<FindElementRequest>,
) -> WebDriverResult {
  let (script_timeout, implicit_ms, var) = {
    let sessions = state.sessions.read().await;
    let session = sessions.get(&session_id)?;
    let v = session
      .elements
      .get(&element_id)
      .ok_or_else(WebDriverErrorResponse::stale_element_reference)?
      .to_string();
    (session.timeouts.script_ms, session.timeouts.implicit_ms, v)
  };
  let child_var = format!("__wdio_child_{}", Uuid::new_v4().simple());
  let locator = match req.using.as_str() {
    "css selector" => format!("window.{var}.querySelector({:?})", req.value),
    "xpath" => format!(
      "document.evaluate({:?}, window.{var}, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue",
      req.value
    ),
    "link text" => format!(
      "(function(){{ for(var a of window.{var}.querySelectorAll('a')) {{ if(a.textContent.trim()==={:?}) return a; }} return null; }})()",
      req.value
    ),
    "partial link text" => format!(
      "(function(){{ for(var a of window.{var}.querySelectorAll('a')) {{ if(a.textContent.includes({:?})) return a; }} return null; }})()",
      req.value
    ),
    "tag name" => format!("window.{var}.getElementsByTagName({:?})[0] ?? null", req.value),
    _ => format!("window.{var}.querySelector({:?})", req.value),
  };
  let script =
    format!("window.{child_var} = {locator}; return window.{child_var} ? '{child_var}' : null");
  let deadline = tokio::time::Instant::now() + Duration::from_millis(implicit_ms);
  loop {
    let result = eval_for_element(&var, script.clone(), script_timeout).await?;
    match result.as_str() {
      Some(v) => {
        let mut sessions = state.sessions.write().await;
        let session = sessions.get_mut(&session_id)?;
        let id = session.elements.insert(v.to_string());
        return Ok(WebDriverResponse::success(json!({ ELEMENT_KEY: id })));
      }
      _ => {
        if tokio::time::Instant::now() >= deadline {
          return Err(WebDriverErrorResponse::no_such_element());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
      }
    }
  }
}

/// POST `/session/{session_id}/element/{element_id}/elements`
pub async fn find_all_from_element(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id)): Path<(String, String)>,
  Json(req): Json<FindElementRequest>,
) -> WebDriverResult {
  let (script_timeout, implicit_ms, var) = {
    let sessions = state.sessions.read().await;
    let session = sessions.get(&session_id)?;
    let v = session
      .elements
      .get(&element_id)
      .ok_or_else(WebDriverErrorResponse::stale_element_reference)?
      .to_string();
    (session.timeouts.script_ms, session.timeouts.implicit_ms, v)
  };
  let prefix = Uuid::new_v4().simple().to_string();
  let collection = match req.using.as_str() {
    "xpath" => format!(
      "(function(){{ var res=document.evaluate({:?},window.{var},null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null); var arr=[]; for(var i=0;i<res.snapshotLength;i++) arr.push(res.snapshotItem(i)); return arr; }})()",
      req.value
    ),
    "link text" => format!(
      "Array.from(window.{var}.querySelectorAll('a')).filter(function(a){{ return a.textContent.trim()==={:?}; }})",
      req.value
    ),
    "partial link text" => format!(
      "Array.from(window.{var}.querySelectorAll('a')).filter(function(a){{ return a.textContent.includes({:?}); }})",
      req.value
    ),
    "tag name" => format!("Array.from(window.{var}.getElementsByTagName({:?}))", req.value),
    _ => format!("Array.from(window.{var}.querySelectorAll({:?}))", req.value),
  };
  let script = format!(
    "return (function(){{ var elems={collection}; var vars=[]; for(var i=0;i<elems.length;i++){{ var k='__wdio_ch_{prefix}_'+i; window[k]=elems[i]; vars.push(k); }} return vars; }})()"
  );
  let deadline = tokio::time::Instant::now() + Duration::from_millis(implicit_ms);
  loop {
    let result = eval_for_element(&var, script.clone(), script_timeout).await?;
    let vars: Vec<String> = result
      .as_array()
      .cloned()
      .unwrap_or_default()
      .into_iter()
      .filter_map(|v| v.as_str().map(str::to_string))
      .collect();
    if !vars.is_empty() || tokio::time::Instant::now() >= deadline {
      let mut sessions = state.sessions.write().await;
      let session = sessions.get_mut(&session_id)?;
      let refs: Vec<Value> = vars
        .into_iter()
        .map(|v| {
          let id = session.elements.insert(v);
          json!({ ELEMENT_KEY: id })
        })
        .collect();
      return Ok(WebDriverResponse::success(refs));
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
  }
}

/// POST `/session/{session_id}/element/{element_id}/click`
pub async fn click(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id)): Path<(String, String)>,
) -> WebDriverResult {
  let (timeout, var) = element_var(&state, &session_id, &element_id).await?;
  eval_for_element(&var, format!("return {}", click_element_script(&var)), timeout).await?;
  Ok(WebDriverResponse::null())
}

/// POST `/session/{session_id}/element/{element_id}/clear`
pub async fn clear(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id)): Path<(String, String)>,
) -> WebDriverResult {
  let (timeout, var) = element_var(&state, &session_id, &element_id).await?;
  let result =
    eval_for_element(&var, format!("return {}", clear_element_script(&var)), timeout).await?;
  if result.as_str() == Some("not editable") {
    return Err(WebDriverErrorResponse::invalid_element_state(
      "element is disabled or read-only, so it cannot be cleared",
    ));
  }
  Ok(WebDriverResponse::null())
}

/// POST `/session/{session_id}/element/{element_id}/value`
pub async fn send_keys(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id)): Path<(String, String)>,
  Json(req): Json<SendKeysRequest>,
) -> WebDriverResult {
  let (timeout, var) = element_var(&state, &session_id, &element_id).await?;
  eval_for_element(&var, format!("return {}", send_keys_script(&var, &req.text)), timeout).await?;
  Ok(WebDriverResponse::null())
}

/// GET `/session/{session_id}/element/{element_id}/text`
pub async fn get_text(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id)): Path<(String, String)>,
) -> WebDriverResult {
  let (timeout, var) = element_var(&state, &session_id, &element_id).await?;
  let result = eval_for_element(
    &var,
    format!("return window.{var}.innerText || window.{var}.textContent || ''"),
    timeout,
  )
  .await?;
  Ok(WebDriverResponse::success(result))
}

/// GET `/session/{session_id}/element/{element_id}/name`
pub async fn get_tag_name(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id)): Path<(String, String)>,
) -> WebDriverResult {
  let (timeout, var) = element_var(&state, &session_id, &element_id).await?;
  let result =
    eval_for_element(&var, format!("return window.{var}.tagName.toLowerCase()"), timeout).await?;
  Ok(WebDriverResponse::success(result))
}

/// GET `/session/{session_id}/element/{element_id}/attribute/{name}`
pub async fn get_attribute(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id, name)): Path<(String, String, String)>,
) -> WebDriverResult {
  let (timeout, var) = element_var(&state, &session_id, &element_id).await?;
  let result =
    eval_for_element(&var, format!("return window.{var}.getAttribute({name:?})"), timeout).await?;
  Ok(WebDriverResponse::success(result))
}

/// GET `/session/{session_id}/element/{element_id}/property/{name}`
pub async fn get_property(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id, name)): Path<(String, String, String)>,
) -> WebDriverResult {
  let (timeout, var) = element_var(&state, &session_id, &element_id).await?;
  let result =
    eval_for_element(&var, format!("return window.{var}[{name:?}] ?? null"), timeout).await?;
  Ok(WebDriverResponse::success(result))
}

/// GET `/session/{session_id}/element/{element_id}/css/{property_name}`
pub async fn get_css_value(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id, prop)): Path<(String, String, String)>,
) -> WebDriverResult {
  let (timeout, var) = element_var(&state, &session_id, &element_id).await?;
  let result = eval_for_element(
    &var,
    format!("return window.getComputedStyle(window.{var}).getPropertyValue({prop:?})"),
    timeout,
  )
  .await?;
  Ok(WebDriverResponse::success(result))
}

/// GET `/session/{session_id}/element/{element_id}/rect`
pub async fn get_rect(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id)): Path<(String, String)>,
) -> WebDriverResult {
  let (timeout, var) = element_var(&state, &session_id, &element_id).await?;
  let result = eval_for_element(
    &var,
    format!(
      "return (function(){{ var r=window.{var}.getBoundingClientRect(); return {{x:r.left,y:r.top,width:r.width,height:r.height}}; }})()"
    ),
    timeout,
  ).await?;
  Ok(WebDriverResponse::success(result))
}

/// GET `/session/{session_id}/element/{element_id}/selected`
pub async fn is_selected(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id)): Path<(String, String)>,
) -> WebDriverResult {
  let (timeout, var) = element_var(&state, &session_id, &element_id).await?;
  let result = eval_for_element(
    &var,
    format!("return !!window.{var}.checked || !!window.{var}.selected"),
    timeout,
  )
  .await?;
  Ok(WebDriverResponse::success(result))
}

/// GET `/session/{session_id}/element/{element_id}/displayed`
pub async fn is_displayed(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id)): Path<(String, String)>,
) -> WebDriverResult {
  let (timeout, var) = element_var(&state, &session_id, &element_id).await?;
  let result = eval_for_element(
    &var,
    format!(
      "return (function(){{ var el=window.{var}; var s=window.getComputedStyle(el); return s.display!=='none' && s.visibility!=='hidden' && s.opacity!=='0'; }})()"
    ),
    timeout,
  ).await?;
  Ok(WebDriverResponse::success(result))
}

/// GET `/session/{session_id}/element/{element_id}/enabled`
pub async fn is_enabled(
  State(state): State<Arc<AppState>>,
  Path((session_id, element_id)): Path<(String, String)>,
) -> WebDriverResult {
  let (timeout, var) = element_var(&state, &session_id, &element_id).await?;
  let result = eval_for_element(&var, format!("return !window.{var}.disabled"), timeout).await?;
  Ok(WebDriverResponse::success(result))
}

/// GET `/session/{session_id}/element/{element_id}/screenshot`
pub async fn take_screenshot(
  State(state): State<Arc<AppState>>,
  Path((session_id, _element_id)): Path<(String, String)>,
) -> WebDriverResult {
  let sessions = state.sessions.read().await;
  let _ = sessions.get(&session_id)?;
  // Placeholder — same as the full-page screenshot.
  Ok(WebDriverResponse::success(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ))
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Where the page records the field Send Keys edited and its value from before the edit: a browser
/// fires `change` when focus leaves an edited field, so the driver fires it then.
const PENDING_CHANGE: &str = "window.__wdio_pending_change";

/// A JS string literal for `text` that is safe to splice into a script.
fn js_string(text: &str) -> String {
  Value::from(text).to_string()
}

/// JS binding `var` to the focused element, looking through open shadow roots.
fn deep_active_element_js(var: &str) -> String {
  format!(
    r"var {var} = document.activeElement || document.body;
                while ({var}.shadowRoot && {var}.shadowRoot.activeElement) {{
                    {var} = {var}.shadowRoot.activeElement;
                }}"
  )
}

/// JS expression that is true when `el` takes typed text: a textarea or a text-like input.
fn is_text_field_js(el: &str) -> String {
  format!(
    "({el}.tagName === 'TEXTAREA' || ({el}.tagName === 'INPUT' && \
     ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].indexOf({el}.type) !== -1))"
  )
}

/// JS firing the `change` a field still owes from Send Keys, unless `keeps_focus` (a JS expression
/// over `pendingField`) holds. The driver runs it before it moves focus, so `change` precedes `blur`.
fn commit_pending_change_js(keeps_focus: &str) -> String {
  format!(
    r"var pendingChange = {PENDING_CHANGE};
                if (pendingChange) {{
                    var pendingField = pendingChange.el;
                    if (!({keeps_focus})) {{
                        {PENDING_CHANGE} = null;
                        if (pendingField.isConnected && pendingField.value !== pendingChange.value) {{
                            pendingField.dispatchEvent(new Event('change', {{ bubbles: true }}));
                        }}
                    }}
                }}"
  )
}

/// JS recording that `el` owes a `change` if its value differs from `initial_value` once focus
/// leaves it. An earlier record for the same field wins, as it holds the value from before the first
/// edit. A `blur` listener covers focus the page moves; there `change` follows `blur`.
fn record_pending_change_js(el: &str, initial_value: &str) -> String {
  let commit_other_field = commit_pending_change_js(&format!("pendingField === {el}"));
  format!(
    r"{commit_other_field}
                if (!{PENDING_CHANGE}) {{
                    var record = {{ el: {el}, value: {initial_value} }};
                    {PENDING_CHANGE} = record;
                    {el}.addEventListener('blur', function onBlur() {{
                        record.el.removeEventListener('blur', onBlur);
                        if ({PENDING_CHANGE} === record) {{
                            {PENDING_CHANGE} = null;
                            if (record.el.value !== record.value) {{
                                record.el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                            }}
                        }}
                    }});
                }}"
  )
}

/// JS clicking `el` and focusing it, firing first any `change` a field owes from Send Keys if the
/// click moves focus away from it.
fn click_element_script(js_var: &str) -> String {
  let active_element = deep_active_element_js("activeEl");
  let text_field = is_text_field_js("el");
  let commit_change =
    commit_pending_change_js("pendingField === el || el.control === pendingField");
  format!(
    r"(function() {{
              var el = window.{js_var};
              if (!el || !el.isConnected) {{
                  throw '__wdio_stale__';
              }}
              {active_element}
              // A caret set before focus stops WebKit selecting a fresh field's text (or putting a
              // textarea's caret first), while a select-on-focus handler still picks its own selection.
              if (activeEl !== el && {text_field}) {{
                  try {{
                      el.setSelectionRange(el.value.length, el.value.length);
                  }} catch (e) {{}}
              }}
              {commit_change}
              el.scrollIntoView({{ block: 'center', inline: 'center' }});
              el.click();
              // Explicitly focus the element after click - programmatic click()
              // doesn't always trigger focus like a real click would
              if (typeof el.focus === 'function') {{
                  el.focus();
              }}
              return true;
          }})()"
  )
}

/// JS for Element Clear with W3C's focusing and unfocusing steps: `el` takes focus, clears with an
/// `input` event, then blurs, firing `change` first if its value differs from its last committed one.
fn clear_element_script(js_var: &str) -> String {
  let commit_change = commit_pending_change_js("pendingField === el");
  format!(
    r"(function() {{
              var el = window.{js_var};
              if (!el || !el.isConnected) {{
                  throw '__wdio_stale__';
              }}
              if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && (el.disabled || el.readOnly)) {{
                  return 'not editable';
              }}
              {commit_change}
              var committedValue = el.value;
              if ({PENDING_CHANGE} && {PENDING_CHANGE}.el === el) {{
                  committedValue = {PENDING_CHANGE}.value;
                  {PENDING_CHANGE} = null;
              }}
              el.focus();
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {{
                  var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                      el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype,
                      'value'
                  ).set;
                  nativeInputValueSetter.call(el, '');
                  var inputEvent = new InputEvent('input', {{
                      bubbles: true,
                      cancelable: true,
                      inputType: 'deleteContentBackward'
                  }});
                  el.dispatchEvent(inputEvent);
                  if (el.value !== committedValue) {{
                      el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                  }}
              }} else if (el.isContentEditable) {{
                  el.innerHTML = '';
              }}
              el.blur();
              return true;
          }})()"
  )
}

/// JS for Element Send Keys: focuses `el`, appends `text` with an `input` event, and records that
/// `el` owes a `change` once focus leaves it if its value differs from before the edit.
fn send_keys_script(js_var: &str, text: &str) -> String {
  let text = js_string(text);
  let commit_change = commit_pending_change_js("pendingField === el");
  let record_change = record_pending_change_js("el", "initialValue");
  format!(
    r"(function() {{
              var el = window.{js_var};
              if (!el || !el.isConnected) {{
                  throw '__wdio_stale__';
              }}
              {commit_change}
              var initialValue = typeof el.value === 'string' ? el.value : null;
              el.focus();
              el.value += {text};
              el.dispatchEvent(new Event('input', {{ bubbles: true }}));
              if (initialValue !== null) {{
                  {record_change}
              }}
              return true;
          }})()"
  )
}

async fn element_var(
  state: &Arc<AppState>,
  session_id: &str,
  element_id: &str,
) -> Result<(u64, String), WebDriverErrorResponse> {
  let sessions = state.sessions.read().await;
  let session = sessions.get(session_id)?;
  let var = session
    .elements
    .get(element_id)
    .ok_or_else(WebDriverErrorResponse::stale_element_reference)?
    .to_string();
  Ok((session.timeouts.script_ms, var))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn click_commits_a_pending_change_unless_it_clicks_that_field_or_its_label() {
    let script = click_element_script("__wdio_elem_abc");
    let commit = script.find(&format!("var pendingChange = {PENDING_CHANGE};")).unwrap();
    assert!(commit < script.find("el.click();").unwrap());
    assert!(commit < script.find("el.focus();").unwrap());
    assert!(script.contains("if (!(pendingField === el || el.control === pendingField)) {"));
  }

  #[test]
  fn clear_fires_input_then_change_against_the_committed_value_then_blurs() {
    let script = clear_element_script("__wdio_elem_abc");
    let commit = script.find("if (!(pendingField === el)) {").unwrap();
    let committed = script.find(&format!("committedValue = {PENDING_CHANGE}.value;")).unwrap();
    let focus = script.find("el.focus();").unwrap();
    let input = script.find("el.dispatchEvent(inputEvent);").unwrap();
    let change = script.find("if (el.value !== committedValue) {").unwrap();
    let blur = script.find("el.blur();").unwrap();
    assert!(commit < committed && committed < focus && focus < input);
    assert!(input < change && change < blur);
    assert_eq!(script.matches("new Event('change'").count(), 2, "{script}");
  }

  #[test]
  fn send_keys_commits_a_pending_change_before_focus_and_defers_its_own_change_to_blur() {
    let script = send_keys_script("__wdio_elem_abc", "it's\n");
    let commit = script.find(&format!("var pendingChange = {PENDING_CHANGE};")).unwrap();
    let focus = script.find("el.focus();").unwrap();
    let input = script.find("el.dispatchEvent(new Event('input'").unwrap();
    let record = script.find("var record = { el: el, value: initialValue };").unwrap();
    assert!(commit < focus && focus < input && input < record);
    assert!(script.contains(&format!("el.value += {};", js_string("it's\n"))));
    assert_eq!(
      script.matches("dispatchEvent(new Event('change'").count(),
      script.matches("pendingField.dispatchEvent(new Event('change'").count()
        + script.matches("record.el.dispatchEvent(new Event('change'").count(),
    );
  }

  #[test]
  fn commit_pending_change_fires_change_once_and_only_for_a_changed_value() {
    let script = commit_pending_change_js("pendingField === el");
    let keeps = script.find("if (!(pendingField === el)) {").unwrap();
    let cleared = script.find(&format!("{PENDING_CHANGE} = null;")).unwrap();
    let changed = script.find("pendingField.value !== pendingChange.value").unwrap();
    let change = script.find("pendingField.dispatchEvent(new Event('change'").unwrap();
    assert!(keeps < cleared && cleared < changed && changed < change);
    assert!(script.contains("pendingField.isConnected"));
  }

  #[test]
  fn record_pending_change_keeps_the_first_edit_and_commits_on_blur() {
    let script = record_pending_change_js("el", "initialValue");
    let other_field = script.find("if (!(pendingField === el)) {").unwrap();
    let only_if_none = script.find(&format!("if (!{PENDING_CHANGE}) {{")).unwrap();
    let blur = script.find("el.addEventListener('blur'").unwrap();
    assert!(other_field < only_if_none && only_if_none < blur);
    let listener = &script[blur..];
    assert!(listener.contains(&format!("if ({PENDING_CHANGE} === record) {{")));
    assert!(listener.contains("record.el.value !== record.value"));
    assert!(listener.contains("record.el.removeEventListener('blur', onBlur);"));
  }
}
