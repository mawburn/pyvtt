/**
https://github.com/cgloeckner/pyvtt/

Copyright (c) 2020-2021 Christian Glöckner
License: MIT (see LICENSE for details)
*/

function registerGm(event) {
  event.preventDefault()

  const gmname = $('#gmname').val()

  $.ajax({
    type: 'POST',
    url: '/vtt/join',
    dataType: 'json',
    data: {
      gmname: gmname,
    },
    success: function (response) {
      // wait for sanizized gm url (as confirm)
      if (response['url'] === null) {
        showError(response['error'])

        // shake input
        $('#gmname').addClass('shake')
        setTimeout(function () {
          $('#gmname').removeClass('shake')
        }, 1000)
      } else {
        // redirect
        window.location = '/'
      }
    },
    error: function (response, msg) {
      handleError(response)
    },
  })
}

function cleanUp(url) {
  $.post((url = '/vtt/clean-up/' + url))
}

function showSchedule(gm, url) {
  $('#schedule').show(500)
  $('#schedule_base_url')[0].value = '/' + gm + '/' + url
}

function createCountdown() {
  let url = $('#schedule_base_url')[0].value

  const day = parseInt($('#day>:selected')[0].value)
  const month = parseInt($('#month>:selected')[0].value)
  const year = $('#year')[0].valueAsNumber
  const hour = parseInt($('#hour>:selected')[0].value)
  const minute = parseInt($('#minute>:selected')[0].value)

  const d = new Date(year, month - 1, day, hour, minute)
  url += '/' + d.getTime().toString(16)

  window.location = url
}

function updateDays() {
  const day = parseInt($('#day>:selected')[0].value)
  const month = parseInt($('#month>:selected')[0].value)
  const year = $('#year')[0].valueAsNumber
  const num_days = new Date(year, month, 0).getDate()

  // refill days for selected month
  let options = ''
  for (let i = 1; i <= num_days; ++i) {
    const selected = i === day ? ' selected' : ''
    const shown = i < 10 ? '0' + i : i
    options += '<option value="' + i + '"' + selected + '>' + shown + '</option>'
  }
  $('#day')[0].innerHTML = options
}

function kickPlayer(url, uuid) {
  const kick = confirm('KICK THIS PLAYER?')
  if (kick) {
    $.post((url = '/vtt/kick-player/' + url + '/' + uuid))
  }
}

function deleteGame(url) {
  const remove = confirm('DELETE THIS GAME?')
  if (remove) {
    $.post(
      (url = '/vtt/delete-game/' + url),
      (success = function (data) {
        $('#gmdrop')[0].innerHTML = data
      })
    )
  }
}

function fancyUrl() {
  // ask server to create nonsense game name
  $.get(
    (url = '/vtt/fancy-url'),
    (success = function (data) {
      $('#url').val(data)
    })
  )
}

function GmUploadDrag(event) {
  event.preventDefault()
}

function GmUploadDrop(event, url_regex, gm_url) {
  event.preventDefault()

  showInfo('LOADING')

  // test upload data sizes
  const queue = $('#uploadqueue')[0]
  queue.files = event.dataTransfer.files
  const sizes_ok = true
  if (queue.files.length !== 1) {
    showError('USE A SINGLE FILE')
    return
  }
  let max_filesize = MAX_BACKGROUND_FILESIZE
  let file_type = 'BACKGROUND'
  if (queue.files[0].name.endsWith('.zip')) {
    max_filesize = MAX_GAME_FILESIZE
    file_type = 'GAME'
  }
  if (queue.files[0].size > max_filesize * 1024 * 1024) {
    showError('TOO LARGE ' + file_type + ' (MAX ' + max_filesize + ' MiB)')
    return
  }

  // fetch upload data
  const f = new FormData($('#uploadform')[0])

  tryGameCreation(f, url_regex)
}

function tryGameCreation(f, url_regex) {
  // test target game url
  const url = $('#url').val()
  if (url !== '') {
    // check url via regex
    r = new RegExp(url_regex, 'g')
    if (!r.test(url)) {
      showError('NO SPECIAL CHARS OR SPACES')

      // shake URL input
      $('#url').addClass('shake')
      setTimeout(function () {
        $('#url').removeClass('shake')
      }, 1000)
      return
    }
  }

  // import game
  $.ajax({
    url: '/vtt/import-game/' + url,
    type: 'POST',
    data: f,
    contentType: false,
    cache: false,
    processData: false,
    success: function (response) {
      url_ok = response['url_ok']
      file_ok = response['file_ok']

      if (!url_ok) {
        showError(response['error'])

        // shake URL input
        $('#url').addClass('shake')
        setTimeout(function () {
          $('#url').removeClass('shake')
        }, 1000)
      } else {
        if (!file_ok) {
          showError(response['error'])

          // reset uploadqueue
          $('#uploadqueue').val('')

          // reset and shake URL input
          $('#dropzone').addClass('shake')
          setTimeout(function () {
            $('#dropzone').removeClass('shake')
          }, 1000)
        } else {
          // load game
          $('#popup').hide()
          window.location = '/' + response['url']
        }
      }
    },
    error: function (response, msg) {
      handleError(response)
    },
  })
}

function GmQuickStart(url_regex) {
  showInfo('LOADING')

  // load transparent image from URL
  const img = new Image()
  img.src = '/static/transparent.png'
  img.onload = function () {
    const blob = getImageBlob(img)
    const f = new FormData()
    f.append('file', blob, 'transparent.png')

    tryGameCreation(f)
  }
}

// --- GM ingame tokenbar handles -------------------------------------

function reloadScenesDropdown() {
  showInfo('Loading')
  $('#gmdrop')[0].innerHTML = ''
  $.post(
    (url = '/vtt/query-scenes/' + game_url),
    (success = function (data) {
      $('#popup').hide()
      $('#gmdrop')[0].innerHTML = data
    })
  )
}

function addScene() {
  writeSocket({
    OPID: 'GM-CREATE',
  })
  reloadScenesDropdown()
}

function moveScene(scene_id, step) {
  writeSocket({
    OPID: 'GM-MOVE',
    scene: scene_id,
    step: step,
  })
  reloadScenesDropdown()
}

function activateScene(scene_id) {
  writeSocket({
    OPID: 'GM-ACTIVATE',
    scene: scene_id,
  })
  reloadScenesDropdown()
}

function cloneScene(scene_id) {
  writeSocket({
    OPID: 'GM-CLONE',
    scene: scene_id,
  })
  reloadScenesDropdown()
}

function deleteScene(scene_id) {
  writeSocket({
    OPID: 'GM-DELETE',
    scene: scene_id,
  })
  reloadScenesDropdown()
}

/*
/// Drag & Drop Replace Scene's Background
/// FIXME: isn't working well, so it's disabled
function onDropNewBackground(scene_id) {
    event.preventDefault();

    var queue = $('#uploadqueue')[0];
    queue.files = event.dataTransfer.files;

    // only accept a single file
    if (queue.files.length !== 1) {
        showError('USE A SINGLE IMAGE');
        return;
    }
    var file = queue.files[0];

    // only accept image file
    content = file.type.split('/')[0];
    if (content !== 'image') {
        showError('USE A SINGLE IMAGE');
        return;
    }

    // check image size
    if (file.size > MAX_BACKGROUND_FILESIZE * 1024 * 1024) {
        showError('TOO LARGE BACKGROUND (MAX ' + MAX_BACKGROUND_FILESIZE + ' MiB');
        return;
    }

    // upload background
    var f = new FormData($('#uploadform')[0]);
    uploadBackground(gm_name, game_url, f, scene_id);
}
*/

function uploadBackground(gm_name, game_url, f) {
  // try to query url based on md5
  //md5 =
  notifyUploadStart(1)

  // upload background
  $.ajax({
    url: '/vtt/upload-background/' + gm_name + '/' + game_url,
    type: 'POST',
    data: f,
    contentType: false,
    cache: false,
    processData: false,
    success: function (response) {
      // reset uploadqueue
      $('#uploadqueue').val('')

      // load images if necessary
      loadImage(response)

      // trigger token creation via websocket
      writeSocket({
        OPID: 'CREATE',
        posx: 0,
        posy: 0,
        size: -1,
        urls: [response],
      })

      $('#popup').hide()
      notifyUploadFinish(1)
    },
    error: function (response, msg) {
      handleError(response)
      notifyUploadFinish(1)
    },
  })
}
