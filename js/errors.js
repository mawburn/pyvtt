/**
https://github.com/cgloeckner/pyvtt/

Copyright (c) 2020-2021 Christian Glöckner
License: MIT (see LICENSE for details)
*/

const show_hints = false

const last_target_hint = null
const target_hint_delay = 1000
const last_hint_time = null

function showPopup(msg, color, timeout, fadeout) {
  const popup = $('#popup')
  popup[0].innerHTML = msg
  popup.css('color', color)
  popup.fadeIn(100, 0.0)
  if (timeout !== null) {
    popup.delay(timeout).fadeOut(fadeout, 0.0)
  }
}

function showError(msg) {
  console.warn(msg)
  showPopup(msg, 'red', 1000, 1000)
}

function showTip(msg) {
  console.warn(msg)
  showPopup(msg, 'white', 500, 500)
}

function showInfo(msg) {
  showPopup(msg, 'white', null, null)
}

function showHint(event, msg) {
  last_hint_target = event.target

  setTimeout(function () {
    showHintNow(event, msg)
  }, target_hint_delay)
}

function showHintNow(event, msg) {
  if (last_hint_target === null || !show_hints) {
    return
  }

  const hint = $('#hint')
  hint[0].innerHTML = msg
  hint.fadeIn(250, 0.0)
}

function hideHint() {
  last_hint_target = null

  const hint = $('#hint')
  hint.fadeOut(10, 0.0)
}

function handleError(response) {
  // parse error_id from response
  const error_id = response.responseText.split('<pre>')[1].split('</pre>')[0]

  // redirect to error page
  window.location = '/vtt/error/' + error_id
}
