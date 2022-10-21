/**
https://github.com/cgloeckner/pyvtt/

Copyright (c) 2020-2021 Christian Glöckner
License: MIT (see LICENSE for details)
*/

let mouse_x = 0 // relative to canvas
let mouse_y = 0

let copy_tokens = [] // determines copy-selected token (CTRL+C)
let select_ids = [] // contains selected tokens' ids
let primary_id = 0 // used to specify "leader" in group (for relative movement)
const mouse_over_id = 0 // determines which token would be selected
let grabbed = false // determines whether grabbed or not

let select_from_x = null
let select_from_y = null

const dice_shake = 750 // ms for shaking animation

let over_player = null // indicates over which player the mouse is located (by name)

const default_dice_pos = {} // default dice positions

const client_side_prediction = true // enable/disable client side prediction (atm used for movement only)

let space_bar = false // whether spacebar is pressed

const token_rotate_lock_threshold = 15 // threshold for lock-in a token rotation
let token_last_angle = null

const fade_dice = true

const SCREEN_BORDER_WIDTH = 0.1 // percentage of screen which is used as border for dragging dice

const dice_sides = [2, 4, 6, 8, 10, 12, 20]

let touch_start = null // starting point for a touch action
let touch_force = 0.0
let was_scrolled = false // indicates whether viewport was dragged/scrolled

// implementation of a double left click
let initial_click = 0
const double_click_limit = 200

// --- token implementation -------------------------------------------

/// Determiens if position is within token's bounding box
function isOverToken(x, y, token) {
  const canvas = $('#battlemap')
  const size = getActualSize(token, canvas[0].width, canvas[0].height)
  const max_width = size[0] * 10 // because of labels
  const max_height = size[1]

  // 1st stage: bounding box test
  if (token.size > 0) {
    const min_x = token.posx - max_width / 2
    const max_x = token.posx + max_width / 2
    const min_y = token.posy - max_height / 2
    const max_y = token.posy + max_height / 2
    const in_box = min_x <= x && x <= max_x && min_y <= y && y <= max_y
    if (!in_box) {
      return false
    }
  }

  // 2nd stage: image alpha test
  // note: query at position relative to token's center
  const dx = x - token.posx
  const dy = y - token.posy
  const pixel_data = getPixelData(token, dx, dy)
  return pixel_data[3] > 0
}

/// Determines which token is selected when clicking the given position
function selectToken(x, y) {
  let result = null
  let bestz = min_z - 1

  // search for any fitting culling with highest z-order (unlocked first)
  $.each(culling, function (index, item) {
    if (item != null && !item.locked && item.zorder > bestz && isOverToken(x, y, item)) {
      bestz = item.zorder
      result = item
    }
  })
  if (result == null) {
    // try locked tokens next
    $.each(culling, function (index, item) {
      if (item != null && item.locked && item.zorder > bestz && isOverToken(x, y, item)) {
        bestz = item.zorder
        result = item
      }
    })
  }

  return result
}

// --- player implementation ------------------------------------------

const players = {}

/// Player constructor
function Player(name, uuid, color, ip, country, agent, flag, index) {
  this.name = name
  this.uuid = uuid
  this.color = color
  this.ip = ip
  this.country = country
  this.agent = agent
  this.flag = flag
  this.index = index
  this.is_last = false
}

function getCookie(key) {
  const arr = document.cookie.split(key + '=')[1]
  if (arr == null) {
    return ''
  }
  return arr.split('; ')[0]
}

function setCookie(key, value) {
  // magical cookie properties :)
  // this REALLY appends / updates based on the current cookie
  document.cookie = key + '=' + value
}

function rebuildPlayers() {
  // build players array sorted by index
  const indices = {}
  $.each(players, function (uuid, p) {
    indices[p.index] = p
  }),
    // rebuild players container
    ($('#players')[0].innerHTML = '')
  $.each(indices, function (index, p) {
    showPlayer(p, true)
  })
}

function showPlayer(p, force = false) {
  if (!force && p.uuid in players) {
    // ignore existing player
    return
  }

  // create player container (uuid as id, custom colored, optional kick click, draggable)
  const coloring =
    ' style="filter: drop-shadow(1px 1px 9px ' +
    p.color +
    ') drop-shadow(-1px -1px 0 ' +
    p.color +
    ');"'
  let ordering = ' onMouseEnter="onMouseOverPlayer(\'' + p.uuid + '\');"'
  ordering += ' onMouseLeave="onMouseLeavePlayer(\'' + p.uuid + '\');"'

  // create player menu for this player
  let menu = '<div class="playermenu" id="playermenu_' + p.uuid + '">'
  if (p.index > 0) {
    menu +=
      '<img src="/static/left.png" draggable="false" class="left" title="MOVE TO LEFT" onClick="onPlayerOrder(-1);" />'
  }
  if (is_gm && p.uuid != my_uuid) {
    menu +=
      '<img src="/static/delete.png" draggable="false" class="center" title="KICK PLAYER" onClick="kickPlayer(\'' +
      game_url +
      "', '" +
      p.uuid +
      '\');" />'
  }
  if (!p.is_last) {
    menu +=
      '<img src="/static/right.png" draggable="false" class="right" title="MOVE TO RIGHT" onMouseLeave="hideHint();" onClick="onPlayerOrder(1);" />'
  }
  menu += '</div>'

  // build player's container
  let agent_str = ''
  if (is_gm) {
    agent_str = ' title="' + p.agent + '"'
  }

  const player_container =
    '<span id="player_' +
    p.uuid +
    '"' +
    ordering +
    ' draggable="true" class="player"' +
    coloring +
    agent_str +
    '>' +
    menu +
    p.flag +
    '&nbsp;' +
    p.name +
    '</span>'

  $('#players').append(player_container)
  players[p.uuid] = p
}

function hidePlayer(uuid) {
  if (uuid in players) {
    $('#player_' + uuid).remove()
    delete players[uuid]
  }
}

// --- dice rolls implementation --------------------------------------

const roll_timeout = 10000.0 // ms until roll will START to disappear

const roll_history = {} // save each player's last dice roll per die

let history_rolled_out = false

function toggleRollHistory() {
  const tray = $('#rollhistory')
  if (history_rolled_out) {
    tray.animate({ right: '-=175' }, 500)
  } else {
    tray.animate({ right: '+=175' }, 500)
  }
  history_rolled_out = !history_rolled_out
}

/// Start dragging dice tray dice
function startDragRoll() {
  localStorage.setItem('drag_data', 'rollbox')
}

/// Drag dice within dice tray
function onDragRoll(event) {
  const parent = $('#rollhistory').position()
  const data = pickScreenPos(event)
  data[0] -= parent['left']
  data[1] -= parent['top']

  localStorage.setItem('roll_pos', JSON.stringify(data))
}

/// Drop dice from dice tray
function stopDragRoll(event, elem) {
  const raw = localStorage.getItem('roll_pos')

  const pos = JSON.parse(raw)
  if (pos[0] < 0 || pos[1] < 0) {
    // grab sides and roll result
    const sides = parseInt(elem.children[0].src.split('token_d')[1].split('.png')[0])
    const result = parseInt(elem.children[1].innerHTML)
    if (!isNaN(result)) {
      onDropTimerInScene(sides, result)
    }
    return
  }

  pos[0] = Math.max(20, Math.min(180, pos[0]))
  pos[1] = Math.max(20, Math.min(380, pos[1]))

  const container = $(elem)
  container.css('left', pos[0])
  container.css('top', pos[1])

  localStorage.removeItem('roll_pos')
  localStorage.removeItem('drag_data')
}

/// Handle clicking a rollhistory's die
function onClickRoll(event, elem) {
  if (event.buttons == 2) {
    elem.remove()
  }
}

/// Adds a roll to the rollhistory dice tray
function logRoll(sides, result) {
  const tray = $('#rollhistory')

  const row = parseInt(Math.random() * 3)
  const col = parseInt(Math.random() * 7)
  const x = 20 + 50 * row + Math.random() * 15
  const y = 20 + 50 * col + Math.random() * 15

  const css = ''
  if (sides == 2) {
    // use D6 as binary dice
    sides = 6
    result = result == 2 ? '<img src="/static/skull.png" />' : ''
  }
  if (sides == 100) {
    // use D10 for D100
    sides = 10
  }

  // calculate player's hue for dice
  const hsl = getHsl(my_color)
  const filter =
    'hue-rotate(' + hsl[0] + 'turn) saturate(' + hsl[1] + ') brightness(' + 2 * hsl[2] + ')'

  const die =
    '<div style="left: ' +
    x +
    'px; top: ' +
    y +
    'px;" draggable="true"' +
    'onDragStart="startDragRoll(event, this);" ' +
    'ontouchstart="startDragRoll(event, this);" ' +
    'ontouchmove="onDragRoll(event);" ' +
    'ontouchend="stopDragRoll(event, this);" ' +
    'onDragEnd="stopDragRoll(event, this);">' +
    '<img src="/static/token_d' +
    sides +
    '.png" style="filter: ' +
    filter +
    ';"><span>' +
    result +
    '</span></div>'

  tray.prepend(die)
  const dom_span = tray.children(':first-child')
  dom_span[0].onmousedown = function (event) {
    onClickRoll(event, $(this))
  }

  dom_span.delay(dice_shake).fadeIn(250, function () {
    if (fade_dice) {
      dom_span.delay(6 * roll_timeout).fadeOut(100, function () {
        this.remove()
      })
    }
  })
}

function addRoll(sides, result, name, color, recent) {
  roll_history[sides + '_' + name] = result

  if (recent && color == my_color) {
    logRoll(sides, result)
  }

  // handling min-/max-rolls
  let ani_css = ''
  let lbl_css = ''
  if (result == 1) {
    ani_css = 'minani'
    lbl_css = ' minroll'
  } else if (result == sides) {
    ani_css = 'maxani'
    lbl_css = ' maxroll'
  }

  // special case: d2
  let result_label = result
  if (sides == 2) {
    result_label =
      result == 2 ? '<img src="/static/skull.png" />' : '<img src="/static/transparent.png" />'
  }

  // special case: d100
  if (sides == 100) {
    // use d10's results box
    sides = 10
    if (result < 10) {
      result_label = '0' + result
    } else if (result == 100) {
      result_label = '00'
    }
  }

  if (recent) {
    // create dice result
    const parent_span = '<span style="display: none;">'
    const box_span = '<span class="roll' + lbl_css + '" style="border: 3px inset ' + color + ';">'
    const result_span = '<span class="result">'
    const player_span = '<span class="player">'
    const dice_result_span =
      parent_span +
      '\n' +
      '\t' +
      box_span +
      '\n' +
      '\t\t' +
      result_span +
      result_label +
      '</span>\n' +
      '\t\t' +
      player_span +
      name +
      '</span>\n' +
      '\t</span>\n' +
      '\t<span class="' +
      ani_css +
      '"></span>\n' +
      '</span>'

    const container = $('#d' + sides + 'rolls')
    container.prepend(dice_result_span)

    // prepare automatic cleanup
    const dom_span = container.children(':first-child')
    dom_span.delay(dice_shake).fadeIn(100, function () {
      if (fade_dice) {
        dom_span.delay(roll_timeout).fadeOut(500, function () {
          this.remove()
        })
      }
    })

    if (ani_css == 'maxani') {
      // let animation fade out earlier
      const ani = $(dom_span.children()[1])
      ani.delay(3000).fadeOut(500)
    }
  }
}

// --- ui event handles -----------------------------------------------

const drag_img = new Image() // Replacement for default drag image
drag_img.src = '/static/transparent.png'

function onDrag(event) {
  const drag_data = localStorage.getItem('drag_data')

  event.preventDefault()
  pickCanvasPos(event)

  if (drag_data == 'rollbox') {
    onDragRoll(event)
  } else if (drag_data == 'players') {
    onDragPlayers(event)
  } else if (drag_data == 'music') {
    onDragMusic(event)
  } else if (primary_id != 0) {
    if (drag_data == 'resize') {
      onTokenResize(event)
    } else if (drag_data == 'rotate') {
      onTokenRotate(event)
    }
  } else {
    onDragDice(event)
  }
}

/// Event handle to perform dice dragging by touch
function onMobileDragDice(event, d) {
  localStorage.setItem('drag_data', d)
  onDragDice(event)
}

function onTokenResize(event) {
  event.preventDefault()

  const first_token = tokens[primary_id]

  // calculate distance between mouse and token
  const dx = first_token.posx - mouse_x
  const dy = first_token.posy - mouse_y
  const scale = Math.sqrt(dx * dx + dy * dy)
  const radius = first_token.size * 0.8

  // normalize distance using distance mouse/icon
  ratio = scale / radius

  // determine min token size based on current zoom
  tmp_min_token_size = parseInt(default_token_size / (1.44 * viewport.zoom))

  // resize all selected tokens
  $.each(select_ids, function (index, id) {
    const token = tokens[id]
    if (token == null || token.locked) {
      return
    }
    let size = Math.round(token.size * ratio * 2)
    size = Math.max(tmp_min_token_size, Math.min(MAX_TOKEN_SIZE, size))
    // save size
    // @NOTE: resizing is updated after completion, meanwhile
    // clide-side prediction kicks in
    token.size = size

    // trigger buffer redraw
    token.label_canvas = null
    token.hue_canvas = null

    // auto-layering preview for large/small tokens
    token.zorder = -parseInt(0.1 * (token.size - 100))
  })
}

function onTokenRotate(event) {
  event.preventDefault()

  const first_token = tokens[primary_id]

  // calculate vectors between origin/icon and origni/mouse
  // note: assuming the rotation icon is at top
  const icon_box = $('#tokenRotate')[0].getBoundingClientRect()
  const canvas_box = $('#battlemap')[0].getBoundingClientRect()
  icon_dx = 0
  icon_dy = -first_token.size * 0.8
  mouse_dx = mouse_x - first_token.posx
  mouse_dy = mouse_y - first_token.posy

  // calculate rotation angle
  dotp = icon_dx * mouse_dx + icon_dy * mouse_dy
  norm_icon = first_token.size * 0.8
  norm_mouse = Math.sqrt(mouse_dx * mouse_dx + mouse_dy * mouse_dy)
  radians = Math.acos(dotp / (norm_icon * norm_mouse))
  angle = (radians * 180) / 3.14

  // try to lock token to multiples of 90 degree
  if (Math.abs(angle) < token_rotate_lock_threshold) {
    angle = 0
  }
  if (Math.abs(angle - 90) < token_rotate_lock_threshold) {
    angle = 90
  }
  if (Math.abs(angle - 180) < token_rotate_lock_threshold) {
    angle = 180
  }
  if (Math.abs(angle - 270) < token_rotate_lock_threshold) {
    angle = 270
  }

  if (mouse_dx < 0) {
    angle *= -1
  }

  // rotate all selected tokens
  $.each(select_ids, function (index, id) {
    const token = tokens[id]
    if (token == null || token.locked) {
      return
    }

    // undo last rotation
    if (token_last_angle != null) {
      token.rotate -= token_last_angle
    }

    // apply rotation
    // @NOTE: rotation is updated after completion, meanwhile
    // clide-side prediction kicks in
    token.rotate += angle
  })

  token_last_angle = angle
}

function isSingleAudio(queue) {
  return queue.files.length == 1 && queue.files[0].type == 'audio/mpeg'
}

function fetchMd5FromImages(filelist, onfinished) {
  const md5s = []
  let num_images = 0

  $.each(filelist, function (index, file) {
    content = file.type.split('/')[0]

    if (content == 'image') {
      ++num_images
    }
  })

  let ready_images = 0
  $.each(filelist, function (index, file) {
    content = file.type.split('/')[0]

    if (content == 'image') {
      const filereader = new FileReader()
      filereader.readAsBinaryString(file)

      filereader.onload = function (event) {
        md5s.push(md5(filereader.result))
        ++ready_images
        if (ready_images == num_images) {
          onfinished(md5s)
        }
      }
    } else {
      // ignore file format but keep array indexing fine
      md5s.push(null)
    }
  })

  if (ready_images == num_images) {
    // probably == 0 if audio only
    onfinished(md5s)
  }
}

function checkFile(file, index) {
  content = file.type.split('/')[0]

  let max_filesize = 0
  let file_type = ''
  // check image filesize
  if (content == 'image') {
    max_filesize = MAX_TOKEN_FILESIZE
    file_type = 'TOKEN'
    if (index == 0 && !background_set) {
      // first file is assumed as background image
      max_filesize = MAX_BACKGROUND_FILESIZE
      file_type = 'BACKGROUND'
    }

    // check music filesize
  } else if (content == 'audio') {
    max_filesize = MAX_MUSIC_FILESIZE
    file_type = 'MUSIC'
  }

  if (file.size > max_filesize * 1024 * 1024) {
    return 'TOO LARGE ' + file_type + ' (MAX ' + max_filesize + ' MiB)'
  }

  if (content == 'audio' && $('#musicslots').children().length == MAX_MUSIC_SLOTS) {
    return 'QUEUE FULL, RIGHT-CLICK SLOT TO CLEAR'
  }

  return ''
}

function onDrop(event) {
  event.preventDefault()
  pickCanvasPos(event)

  if (localStorage.getItem('drag_data') != null) {
    // ignore
    return
  }
  const files = event.dataTransfer.files // workaround for chrome

  // check file sizes
  let error_msg = ''
  $.each(event.dataTransfer.files, function (index, file) {
    if (error_msg != '') {
      return
    }

    error_msg = checkFile(file, index)
  })

  if (error_msg != '') {
    showError(error_msg)
    return
  }

  fetchMd5FromImages(files, function (md5s) {
    uploadFilesViaMd5(gm_name, game_url, md5s, files, mouse_x, mouse_y)
  })
}

function uploadFilesViaMd5(gm_name, game_url, md5s, files, at_x, at_y) {
  // query server with hashes
  $.ajax({
    type: 'POST',
    url: '/' + gm_name + '/' + game_url + '/hashtest',
    dataType: 'json',
    data: {
      hashs: md5s,
    },
    success: function (response) {
      const known_urls = response['urls']

      // upload files
      const f = new FormData()
      const total_urls = []

      $.each(files, function (index, file) {
        content = file.type.split('/')[0]

        if (content == 'image') {
          // add unknown image file
          if (known_urls[index] == null) {
            f.append('file[]', file)
          }
        } else if (content == 'audio') {
          // add audio file
          f.append('file[]', file)
        }
      })

      // upload and drop tokens at mouse pos
      uploadFiles(gm_name, game_url, f, known_urls, at_x, at_y)
    },
    error: function (response, msg) {
      handleError(response)
    },
  })
}

function uploadFiles(gm_name, game_url, f, known_urls, x, y) {
  notifyUploadStart(f.length)

  $.ajax({
    url: '/' + gm_name + '/' + game_url + '/upload',
    type: 'POST',
    data: f,
    contentType: false,
    cache: false,
    processData: false,
    success: function (response) {
      // reset uploadqueue
      $('#uploadqueue').val('')

      response = JSON.parse(response)

      // load images if necessary
      if (response['urls'].length + known_urls.length > 0) {
        const total_urls = []

        $.each(response['urls'], function (index, url) {
          loadImage(url)
          total_urls.push(url)
        })

        $.each(known_urls, function (index, url) {
          if (url != null) {
            total_urls.push(url)
          }
        })

        // trigger token creation via websocket
        writeSocket({
          OPID: 'CREATE',
          posx: x,
          posy: y,
          size: Math.round(default_token_size / viewport.zoom),
          urls: total_urls,
        })
      }

      if (response['music'].length > 0) {
        if (response['music'][0] == null) {
          // notify full slots
          showError('QUEUE FULL, RIGHT-CLICK SLOT TO CLEAR')
        } else {
          // broadcast music upload
          writeSocket({
            OPID: 'MUSIC',
            action: 'add',
            slots: response['music'],
          })
        }
      }
      notifyUploadFinish(f.length)
    },
    error: function (response, msg) {
      notifyUploadFinish(f.length)
      handleError(response)
    },
  })
}

function showTokenbar(token_id) {
  if (select_ids.includes(token_id)) {
    $('#tokenbar').css('visibility', 'visible')
  } else {
    $('#tokenbar').css('visibility', 'hidden')
  }
}

const token_icons = [
  'Rotate',
  'Top',
  'Delete',
  'Bottom',
  'Label',
  'Resize',
  'FlipX',
  'Clone',
  'Lock',
]

function updateTokenbar() {
  $('#tokenbar').css('visibility', 'hidden')

  if (primary_id && !grabbed) {
    token = tokens[primary_id]

    if (token == null) {
      return
    }

    // cache image if necessary
    if (!images.includes(token.url)) {
      images[token.url] = new Image()
      images[token.url].src = token.url
    }

    // image size aspect ratio
    const src_h = images[token.url].height
    const src_w = images[token.url].width
    const ratio = src_w / src_h

    // determine token size
    const canvas = $('#battlemap')
    let size = token.size * viewport.zoom
    if (size == -1) {
      size = canvas[0].height
    } else if (size < 50) {
      size = 50
    }

    // position tokenbar centered to token
    const canvas_pos = canvas.position()
    let x = token.posx
    let y = token.posy

    // consider viewport position
    x -= viewport.x
    y -= viewport.y
    x += MAX_SCENE_WIDTH / 2
    y += (MAX_SCENE_WIDTH * canvas_ratio) / 2

    // consider viewport zooming (centered)
    x -= MAX_SCENE_WIDTH / 2
    y -= (MAX_SCENE_WIDTH / 2) * canvas_ratio
    x *= viewport.zoom
    y *= viewport.zoom
    x += MAX_SCENE_WIDTH / 2
    y += (MAX_SCENE_WIDTH / 2) * canvas_ratio

    // consider canvas scale (by windows size)
    x *= canvas_scale
    y *= canvas_scale

    $('#tokenbar').css('left', canvas_pos.left + 'px')
    $('#tokenbar').css('top', canvas_pos.top + 'px')
    $('#tokenbar').css('visibility', 'visible')

    // padding avoids icons out of clickable range (especially
    // at the top, versus the GM's dropdown)
    const padding = 20

    const icons = [token_icons]
    var isInt = token.text.startsWith('#') || (!isNaN(token.text) && token.text != '')

    if (isInt) {
      icons.push(['LabelInc', 'LabelDec'])
    }

    $.each(icons, function (i, use_icons) {
      $.each(use_icons, function (index, name) {
        // calculate position based on angle
        const degree = 360.0 / use_icons.length
        const s = Math.sin((-index * degree * 3.14) / 180)
        const c = Math.cos((-index * degree * 3.14) / 180)

        let radius = size * 0.7 * canvas_scale
        if (i == 1) {
          // shrink radius for inner icons
          radius *= 0.5
        }
        if (
          /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
        ) {
          // make tokenbar radius larger on mobile
          radius *= 1.1
        }
        let icon_x = x - radius * s
        let icon_y = y - radius * c

        // force position to be on the screen
        icon_x = Math.max(padding, Math.min(canvas.width() - padding, icon_x))
        icon_y = Math.max(padding, Math.min(canvas.height() - padding, icon_y))

        // place icon
        const icon = $('#token' + name)
        const w = icon.width()
        const h = icon.height()
        icon.css('left', icon_x - w / 2 + 'px')
        icon.css('top', icon_y - h / 2 + 'px')
      })
    })

    // handle locked mode
    if (token.locked) {
      $('#tokenFlipX').css('visibility', 'hidden')
      $('#tokenLock')[0].src = '/static/locked.png'
      $('#tokenTop').css('visibility', 'hidden')
      $('#tokenBottom').css('visibility', 'hidden')
      $('#tokenResize').css('visibility', 'hidden')
      $('#tokenRotate').css('visibility', 'hidden')
      $('#tokenClone').css('visibility', 'hidden')
      $('#tokenDelete').css('visibility', 'hidden')
      $('#tokenLabel').css('visibility', 'hidden')
      $('#tokenLabelDec').css('visibility', 'hidden')
      $('#tokenLabelInc').css('visibility', 'hidden')
    } else {
      $('#tokenFlipX').css('visibility', '')
      $('#tokenLock')[0].src = '/static/unlocked.png'
      $('#tokenTop').css('visibility', '')
      $('#tokenBottom').css('visibility', '')
      $('#tokenResize').css('visibility', '')
      $('#tokenRotate').css('visibility', '')
      $('#tokenClone').css('visibility', '')
      $('#tokenDelete').css('visibility', '')
      $('#tokenLabel').css('visibility', '')

      var isInt = token.text.startsWith('#') || (!isNaN(token.text) && token.text != '')

      if (isInt) {
        $('#tokenLabelDec').css('visibility', '')
        $('#tokenLabelInc').css('visibility', '')
      } else {
        $('#tokenLabelDec').css('visibility', 'hidden')
        $('#tokenLabelInc').css('visibility', 'hidden')
      }
    }
  }
}

// ----------------------------------------------------------------------------

/// Select mouse/touch position relative to the screen
function pickScreenPos(event) {
  if ((event.type == 'touchstart' || event.type == 'touchmove') && event.touches.length == 1) {
    const touchobj = event.touches[0]
    var x = touchobj.clientX
    var y = touchobj.clientY
  } else {
    var x = event.clientX
    var y = event.clientY
  }

  return [x, y]
}

let mouse_delta_x = 0
let mouse_delta_y = 0

/// Select mouse/touch position relative to the canvas
function pickCanvasPos(event) {
  const old_x = mouse_x
  const old_y = mouse_y

  const p = pickScreenPos(event)
  mouse_x = p[0]
  mouse_y = p[1]

  // make pos relative to canvas
  const canvas = $('#battlemap')[0]
  const box = canvas.getBoundingClientRect()
  mouse_x = mouse_x - box.left
  mouse_y = mouse_y - box.top

  // consider canvas scale (by windows size)
  mouse_x /= canvas_scale
  mouse_y /= canvas_scale

  // consider viewport zooming (centered)
  mouse_x -= MAX_SCENE_WIDTH / 2
  mouse_y -= (MAX_SCENE_WIDTH * canvas_ratio) / 2
  mouse_x /= viewport.zoom
  mouse_y /= viewport.zoom
  mouse_x += MAX_SCENE_WIDTH / 2
  mouse_y += (MAX_SCENE_WIDTH * canvas_ratio) / 2

  // consider (centered) viewport position
  mouse_x += viewport.x
  mouse_y += viewport.y
  mouse_x -= MAX_SCENE_WIDTH / 2
  mouse_y -= (MAX_SCENE_WIDTH * canvas_ratio) / 2

  mouse_x = parseInt(mouse_x)
  mouse_y = parseInt(mouse_y)

  mouse_delta_x = mouse_x - old_x
  mouse_delta_y = mouse_y - old_y
}

/// Event handle for pinging with the mouse (left click held)
function onDoubleClick() {
  writeSocket({
    OPID: 'BEACON',
    x: mouse_x,
    y: mouse_y,
  })
}

/// Event handle for start grabbing a token
function onGrab(event) {
  event.preventDefault()
  closeGmDropdown()

  pickCanvasPos(event)
  if (!space_bar && event.buttons != 4) {
    // reset "user was scrolling" memory
    was_scrolled = false
  }

  const is_single_touch = event.type == 'touchstart' && event.touches.length == 1
  const is_pinch_touch = event.type == 'touchstart' && event.touches.length == 2
  if (is_pinch_touch) {
    touch_start = calcPinchCenter()
    pinch_distance = calcPinchDistance()
    return
  } else if (is_single_touch) {
    touch_start = [mouse_x, mouse_y]
    touch_force = event.touches[0].force
  }

  if (event.buttons == 1 || is_single_touch) {
    // trigger check for holding the click
    now = Date.now()
    const time_delta = now - initial_click
    initial_click = now
    if (time_delta <= double_click_limit) {
      onDoubleClick()
    }

    // Left Click: select token
    const token = selectToken(mouse_x, mouse_y)

    if (primary_id > 0 && event.shiftKey) {
      // trigger range query from primary token to mouse pos or next token
      const pt = tokens[primary_id]
      const x1 = pt.posx
      const y1 = pt.posy

      let x2 = mouse_x
      let y2 = mouse_x

      if (token != null) {
        x2 = token.posx
        y2 = token.posy
      }

      let adding = false // default: not adding to the selection
      if (event.ctrlKey || event.metaKey) {
        adding = true
      }

      writeSocket({
        OPID: 'RANGE',
        adding: adding,
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        width: Math.abs(x1 - x2),
        height: Math.abs(y1 - y2),
      })
    } else if (token != null) {
      $('#battlemap').css('cursor', 'move')

      let modified = false

      if (event.ctrlKey || event.metaKey) {
        // toggle token in/out selection group
        const index = select_ids.indexOf(token.id)
        if (index != -1) {
          // remove from selection
          select_ids.splice(index, 1)
        } else {
          // add to selection
          select_ids.push(token.id)
        }
        primary_id = select_ids[0]
        modified = true
      } else {
        // reselect only if token wasn't selected before
        if (!select_ids.includes(token.id)) {
          select_ids = [token.id]
          primary_id = token.id
        } else {
          primary_id = token.id
        }
        modified = true
        grabbed = true
      }

      if (modified) {
        // notify server about selection
        writeSocket({
          OPID: 'SELECT',
          selected: select_ids,
        })
      }
    } else if (!space_bar) {
      if (is_single_touch && !isExtremeForce(touch_force)) {
        // Clear selection
        select_ids = []
        primary_id = 0
      }

      // start selection box
      select_from_x = mouse_x
      select_from_y = mouse_y

      // immediately reset selection if strong touch
      // or if scrolling with spacebar
      // @NOTE: use a light gesture (e.g. pen) to select
      if (is_single_touch && isExtremeForce(event.touches[0].force)) {
        select_from_x = null
        select_from_y = null
      }

      if (token == null) {
        // unselect
        writeSocket({
          OPID: 'RANGE',
          adding: false,
          left: mouse_x,
          top: mouse_x,
          width: 0,
          height: 0,
        })
      }
    }
  } else if (event.buttons == 2 && !is_single_touch) {
    // Right click: reset token scale, flip-x & rotation
    const changes = []
    $.each(select_ids, function (index, id) {
      const token = tokens[id]

      if (token.locked) {
        // ignore if locked
        return
      }

      // reset rotation
      token.rotate = 0

      // reset size to default size (but based on zoom)
      token.size = parseInt(default_token_size / viewport.zoom)

      // trigger buffer redraw
      token.label_canvas = null
      token.hue_canvas = null

      changes.push({
        id: id,
        size: token.size,
        rotate: token.rotate,
        flipx: false,
      })
    })

    writeSocket({
      OPID: 'UPDATE',
      changes: changes,
    })
  }
}

/// Event handle for releasing click/touch (outside canvas)
function onReleaseDoc() {
  if ((!space_bar || was_touch) && !was_scrolled) {
    if (select_from_x != null) {
      // range select tokens (including resetting selection)

      let select_width = mouse_x - select_from_x
      let select_height = mouse_y - select_from_y

      // handle box created to the left
      if (select_width < 0) {
        select_from_x = select_from_x + select_width
        select_width *= -1
      }

      // handle box created to the top
      if (select_height < 0) {
        select_from_y = select_from_y + select_height
        select_height *= -1
      }

      primary_id = 0

      let adding = false // default: not adding to the selection
      if (event.ctrlKey || event.metaKey) {
        adding = true
      }

      writeSocket({
        OPID: 'RANGE',
        adding: adding,
        left: select_from_x,
        top: select_from_y,
        width: select_width,
        height: select_height,
      })
    }
  }

  select_from_x = null
  select_from_y = null
}

/// Event handle for releasing a grabbed token
function onRelease() {
  const was_grabbed = grabbed
  if (select_ids.length > 0) {
    grabbed = false
    $('#battlemap').css('cursor', 'grab')
  }

  touch_force = 0.0
  touch_start = null
  const was_touch = event.type == 'touchend'

  if (isNaN(mouse_x) || isNaN(mouse_y)) {
    // WORKAROUND: prevent mobile from crashing on pinch-zoom
    return
  }

  if (primary_id > 0 && was_grabbed) {
    // finally push movement update to the server
    const changes = []

    $.each(select_ids, function (index, id) {
      const t = tokens[id]
      if (!t.locked) {
        changes.push({
          id: id,
          posx: parseInt(t.newx),
          posy: parseInt(t.newy),
        })
      }
    })

    writeSocket({
      OPID: 'UPDATE',
      changes: changes,
    })
  }
}

/// Limit viewport's position
function limitViewportPosition() {
  const canvas = $('#battlemap')[0]
  const width = MAX_SCENE_WIDTH
  const height = MAX_SCENE_WIDTH * canvas_ratio

  // calculate visible area
  const visible_w = width / viewport.zoom
  const visible_h = height / viewport.zoom

  const min_x = visible_w / 2
  const min_y = visible_h / 2
  const max_x = width - min_x
  const max_y = height - min_y

  viewport.x = Math.max(min_x, Math.min(max_x, viewport.x))
  viewport.y = Math.max(min_y, Math.min(max_y, viewport.y))
}

function onMoveToken(event) {
  const token = tokens[primary_id]

  if (token == null || token.locked) {
    // skip: no primary token or it is locked
    return
  }

  // transform cursor
  const battlemap = $('#battlemap')

  if (token == null) {
    battlemap.css('cursor', 'default')
  } else if (token.locked) {
    battlemap.css('cursor', 'not-allowed')
  } else if (grabbed) {
    battlemap.css('cursor', 'move')
  } else {
    battlemap.css('cursor', 'grab')
  }

  // move all selected tokens relative to the primary one
  const prev_posx = token.posx
  const prev_posy = token.posy

  const changes = []
  $.each(select_ids, function (index, id) {
    const t = tokens[id]
    if (!t.locked) {
      // get position relative to primary token
      const dx = t.posx - prev_posx
      const dy = t.posy - prev_posy
      // move relative to primary token
      let tx = mouse_x + dx
      let ty = mouse_y + dy

      // limit pos to screen (half size as padding)
      // @NOTE: padding isn't enough (see: resize, rotation), maybe it's even desired not do pad it
      const padding_x = 0
      const padding_y = 0
      tx = Math.max(padding_x, Math.min(tx, MAX_SCENE_WIDTH - padding_x))
      ty = Math.max(padding_y, Math.min(ty, MAX_SCENE_WIDTH * canvas_ratio - padding_y))

      if (client_side_prediction) {
        // client-side predict (immediately place it there)
        t.posx = tx
        t.posy = ty
      }
      t.newx = tx
      t.newy = ty

      changes.push({
        id: id,
        posx: parseInt(tx),
        posy: parseInt(ty),
      })
    }
  })

  // not push every position to go easy on the server
  if (socket_move_timeout <= Date.now()) {
    writeSocket({
      OPID: 'UPDATE',
      changes: changes,
    })
    socket_move_timeout = Date.now() + socket_move_delay
  }
}

function onMoveViewport(dx, dy) {
  // change icon
  const battlemap = $('#battlemap')
  battlemap.css('cursor', 'grab')

  // NOTE: some browsers go crazy
  if (dx > 100) {
    dx /= 100
  }
  if (dy > 100) {
    dy /= 100
  }

  // move viewport
  viewport.newx = viewport.x + dx
  viewport.newy = viewport.y + dy

  was_scrolled = true
}

function isExtremeForce(force) {
  return force == 0.0 || force == 1.0
}

/// Event handle for moving mouse/finger
function onMove(event) {
  if (event.type == 'touchmove') {
    // prevent scrolling
    event.preventDefault()
  }

  pickCanvasPos(event)

  const is_single_touch = event.type == 'touchmove' && event.touches.length == 1
  const is_pinch_touch = event.type == 'touchmove' && event.touches.length == 2

  if (is_pinch_touch) {
    // interpret pinch as zooming
    onWheel(event)
  } else if ((event.buttons == 1 && !space_bar) || is_single_touch) {
    // handle left click (without spacebar) or touch event
    if (primary_id != 0 && grabbed) {
      onMoveToken(event)
    } else if (is_single_touch) {
      if (isExtremeForce(touch_force)) {
        // only handle hard pressure (finger) as movement
        var dx = mouse_x - touch_start[0]
        var dy = mouse_y - touch_start[1]
        dx *= 3 / viewport.zoom
        dy *= 3 / viewport.zoom
        // @NOTE: move against drag direction
        onMoveViewport(-dx, -dy)
      }
    }
  } else if (event.buttons == 4 || (event.buttons == 1 && space_bar)) {
    // handle wheel click or leftclick (with space bar)
    // @NOTE: move against drag direction
    var dx = -event.movementX / viewport.zoom
    var dy = -event.movementY / viewport.zoom
    onMoveViewport(dx, dy)
  } else {
    // handle token mouse over
    const token = selectToken(mouse_x, mouse_y)

    // transform cursor
    const battlemap = $('#battlemap')
    if (token == null) {
      battlemap.css('cursor', 'default')
    } else if (token.locked) {
      battlemap.css('cursor', 'not-allowed')
    } else {
      battlemap.css('cursor', 'grab')
    }
  }
}

var pinch_distance = null

/// Calculate distance between fingers during pinch (two fingers)
function calcPinchDistance() {
  const x1 = event.touches[0].clientX
  const y1 = event.touches[0].clientY
  const x2 = event.touches[1].clientX
  const y2 = event.touches[1].clientY
  const dx = x1 - x2
  const dy = y1 - y2
  // @NOTE: sqrt is ignored here for gaining maximum speed
  return dx * dx + dy * dy
}

/// Calculate center between fingers during pinch (two fingers)
function calcPinchCenter() {
  const x1 = event.touches[0].clientX
  const y1 = event.touches[0].clientY
  const x2 = event.touches[1].clientX
  const y2 = event.touches[1].clientY
  x = (x1 + x2) / 2
  y = (y1 + y2) / 2
  return [x, y]
}

/// Event handle mouse wheel scrolling
function onWheel(event) {
  const speed = ZOOM_FACTOR_SPEED
  let delta = event.deltaY

  // default: zoom using viewport's center
  let reference_x = viewport.x
  let reference_y = viewport.y
  if (delta < 0) {
    // zoom using mouse position
    reference_x = mouse_x
    reference_y = mouse_y
  }

  const is_pinch_touch = event.type == 'touchmove' && event.touches.length == 2
  if (is_pinch_touch && pinch_distance != null) {
    // calculate pinch direction (speed is ignored!)
    const new_pinch_distance = calcPinchDistance()
    delta = pinch_distance - new_pinch_distance
    if (Math.abs(delta) < 500) {
      // hardcoded threshold
      // ignore too subtle pinch
      return
    }

    reference_x = touch_start[0]
    reference_y = touch_start[1]

    pinch_distance = new_pinch_distance
  }

  if (event.ctrlKey || event.metaKey) {
    // ignore browser zoom
    return
  }
  let show = false
  const canvas = $('#battlemap')

  // modify zoom
  if (delta > 0) {
    // zoom out
    viewport.zoom /= speed
    if (viewport.zoom < 1.0) {
      viewport.zoom = 1.0
    }
    show = true
  } else if (delta < 0) {
    // zoom in
    viewport.zoom *= speed
    show = true
  }

  // force all token labels to be redrawn
  $.each(tokens, function (index, token) {
    if (token != null) {
      token.hue_canvas = null
    }
  })

  // calculate view's position
  const rel_x = reference_x / MAX_SCENE_WIDTH
  const rel_y = reference_y / (MAX_SCENE_WIDTH * canvas_ratio)
  const x = MAX_SCENE_WIDTH * rel_x
  const y = MAX_SCENE_WIDTH * canvas_ratio * rel_y

  // shift viewport position slightly towards desired direction
  if (x > viewport.x) {
    viewport.x += ZOOM_MOVE_SPEED / viewport.zoom
    if (viewport.x > x) {
      viewport.x = x
    }
  } else if (x < viewport.x) {
    viewport.x -= ZOOM_MOVE_SPEED / viewport.zoom
    if (viewport.x < x) {
      viewport.x = x
    }
  }
  if (y > viewport.y) {
    viewport.y += ZOOM_MOVE_SPEED / viewport.zoom
    if (viewport.y > y) {
      viewport.y = y
    }
  } else if (y < viewport.y) {
    viewport.y -= ZOOM_MOVE_SPEED / viewport.zoom
    if (viewport.y < y) {
      viewport.y = y
    }
  }

  limitViewportPosition()
  displayZoom()
}

const d100_queue = []

/// Event handle to click a dice
function rollDice(sides) {
  // trigger dice shaking and poof (by re-applying CSS class)
  const target = $('#d' + sides + 'icon')
  const poofani = $('#d' + sides + 'poofani')
  // @NOTE: delay required (else nothing will happen)
  target.removeClass('shake').hide().delay(10).show().addClass('shake')
  poofani.removeClass('dicepoof').hide().delay(10).show().addClass('dicepoof')

  if (sides == 10) {
    if (d100_queue[0] != 10) {
      // bank d10 and schedule roll
      d100_queue.push(10)
      setTimeout(function () {
        writeSocket({
          OPID: 'ROLL',
          sides: d100_queue.shift(),
        })
      }, 250)
    } else {
      // morph banked d10 into d100
      d100_queue[0] = 100
    }
  } else {
    writeSocket({
      OPID: 'ROLL',
      sides: sides,
    })
  }
}

function toggleDiceHistory() {
  const history = $('#dicehistory')

  if (history.css('display') == 'none') {
    history.fadeIn(500)
  } else {
    history.fadeOut(500)
  }
}

/// Event handle to select all tokens
function selectAllTokens() {
  event.preventDefault()

  select_ids = []
  $.each(tokens, function (index, token) {
    if (token != null && token.size != -1) {
      select_ids.push(token.id)
    }
  })

  if (select_ids.length > 0 && primary_id == null) {
    primary_id = select_ids[0]
  }
}

/// Event handle to copy selected tokens
function copySelectedTokens() {
  event.preventDefault()

  copy_tokens = select_ids
}

/// Event handle to paste copied tokens
function pasteCopiedTokens() {
  event.preventDefault()

  if (copy_tokens.length > 0) {
    writeSocket({
      OPID: 'CLONE',
      ids: copy_tokens,
      posx: mouse_x,
      posy: mouse_y,
    })
  }
}

/// Event handle to delete selected tokens
function deleteSelectedTokens() {
  event.preventDefault()

  if (select_ids.length > 0) {
    writeSocket({
      OPID: 'DELETE',
      tokens: select_ids,
    })
  }
}

const viewport_scroll_delta = 50

/// Event handle shortcuts on (first) selected token
function onShortcut(event) {
  let hovered_sides = null
  $('#dicebox')
    .find('img')
    .each(function () {
      if ($(this).is(':hover')) {
        hovered_sides = parseInt(this.id.split('drag')[0].split('d')[1])
      }
    })
  if (hovered_sides != null) {
    // trigger 1-9 dice rolls
    if (1 <= event.key && event.key <= 9) {
      for (let i = 0; i < event.key; ++i) {
        rollDice(hovered_sides)
      }
    }
  }

  space_bar = event.key == ' '

  // metaKey for Mac's Command Key
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() == 'a') {
      selectAllTokens()
    } else if (event.key.toLowerCase() == 'c') {
      copySelectedTokens()
    } else if (event.key.toLowerCase() == 'v') {
      pasteCopiedTokens()
    }
  } else {
    // Backspace for MacBook's delete key
    if (event.key == 'Delete' || event.key == 'Backspace') {
      deleteSelectedTokens()
    }

    // handle movement of zoomed viewport
    // @NOTE: move with arrow direction
    if (event.key == 'ArrowUp') {
      onMoveViewport(0, -viewport_scroll_delta / viewport.zoom)
    }
    if (event.key == 'ArrowDown') {
      onMoveViewport(0, viewport_scroll_delta / viewport.zoom)
    }
    if (event.key == 'ArrowLeft') {
      onMoveViewport(-viewport_scroll_delta / viewport.zoom, 0)
    }
    if (event.key == 'ArrowRight') {
      onMoveViewport(viewport_scroll_delta / viewport.zoom, 0)
    }
  }
}

/// Event handle for releasing a key
function onKeyRelease(event) {
  space_bar = false
}

/// Event handle for fliping a token x-wise
function onFlipX() {
  event.preventDefault()

  const changes = []
  $.each(select_ids, function (index, id) {
    const token = tokens[id]

    if (token == null || token.locked) {
      // ignore if locked
      return
    }
    token.flipx = !token.flipx

    changes.push({
      id: id,
      flipx: token.flipx,
    })
  })

  writeSocket({
    OPID: 'UPDATE',
    changes: changes,
  })
}

/// Event handle for (un)locking a token
function onLock() {
  event.preventDefault()

  // determine primary lock state
  let primary_lock = false
  if (primary_id > 0) {
    primary_lock = tokens[primary_id].locked
  }

  const changes = []
  $.each(select_ids, function (index, id) {
    const token = tokens[id]
    token.locked = !primary_lock

    // trigger buffer redraw
    token.label_canvas = null
    token.hue_canvas = null

    changes.push({
      id: id,
      locked: token.locked,
    })
  })

  writeSocket({
    OPID: 'UPDATE',
    changes: changes,
  })
}

/// Event handle for resize a token
function onStartResize() {
  event.dataTransfer.setDragImage(drag_img, 0, 0)
  localStorage.setItem('drag_data', 'resize')
}

/// Event handle for rotating a token
function onStartRotate() {
  event.dataTransfer.setDragImage(drag_img, 0, 0)
  localStorage.setItem('drag_data', 'rotate')
}

/// Event handle for ending token resize
function onQuitResize() {
  const changes = []
  $.each(select_ids, function (index, id) {
    changes.push({
      id: id,
      size: tokens[id].size,
      zorder: tokens[id].zorder,
    })
  })

  writeSocket({
    OPID: 'UPDATE',
    changes: changes,
  })
}

/// Event handle for ending token rotate
function onQuitRotate() {
  const changes = []
  $.each(select_ids, function (index, id) {
    changes.push({
      id: id,
      rotate: tokens[id].rotate,
    })
  })

  writeSocket({
    OPID: 'UPDATE',
    changes: changes,
  })

  token_last_angle = null
}

/// Event handle for quitting rotation/resize dragging
function onQuitAction(event) {
  const action = localStorage.getItem('drag_data')
  if (action == 'rotate') {
    onQuitRotate()
  } else if (action == 'resize') {
    onQuitResize()
  }

  localStorage.removeItem('drag_data')
}

/// Event handle for moving token to lowest z-order
function onBottom() {
  event.preventDefault()

  const changes = []
  $.each(select_ids, function (index, id) {
    const token = tokens[id]

    if (token.locked) {
      // ignore if locked
      return
    }
    // move beneath lowest known z-order
    if (token.locked) {
      token.zorder = 1
    } else {
      token.zorder = min_z - 1
      --min_z
    }

    changes.push({
      id: id,
      zorder: token.zorder,
    })
  })

  writeSocket({
    OPID: 'UPDATE',
    changes: changes,
  })
}

/// Event handle for changing a numeric token label
function onLabelStep(delta) {
  event.preventDefault()

  const changes = []
  const deleted = []

  $.each(select_ids, function (index, id) {
    const token = tokens[id]
    if (token == null) {
      return
    }
    const isTimer = token.text.startsWith('#')
    const isInt = isTimer || (!isNaN(token.text) && token.text != '')

    if (token == null || token.locked || !isInt) {
      // ignore if locked
      return
    }

    const prev = token.text

    // click token's number
    if (isTimer) {
      var number = parseInt(token.text.substr(1))
    } else {
      var number = parseInt(token.text)
    }
    number += delta
    if (number <= 0) {
      number = 0
    }
    if (isTimer) {
      token.text = '#'
    } else {
      token.text = ''
    }
    if (number > 0) {
      token.text += number
    }

    // trigger buffer redraw
    token.label_canvas = null
    token.hue_canvas = null

    if (number == 0 && isTimer) {
      deleted.push(id)
    } else {
      changes.push({
        id: id,
        text: token.text,
      })
    }
    console.log(id, 'from', prev, 'to', token.text)
  })

  writeSocket({
    OPID: 'UPDATE',
    changes: changes,
  })

  if (deleted.length > 0) {
    writeSocket({
      OPID: 'DELETE',
      tokens: deleted,
    })
  }
}

/// Event handle for entering a token label
function onLabel() {
  event.preventDefault()

  if (select_ids.length == 0) {
    return
  }

  const primary = tokens[select_ids[0]]
  let text = window.prompt('TOKEN LABEL (MAX LENGTH 15)', primary.text)
  if (text == null) {
    return
  }

  // apply text
  text = text.substr(0, 15)
  const changes = []

  $.each(select_ids, function (index, id) {
    const token = tokens[id]

    if (token.locked) {
      // ignore if locked
      return
    }

    // move beneath lowest known z-order
    token.text = text

    // trigger buffer redraw
    token.label_canvas = null
    token.hue_canvas = null

    changes.push({
      id: id,
      text: text,
    })
  })

  writeSocket({
    OPID: 'UPDATE',
    changes: changes,
  })
}

/// Event handle for moving token to hightest z-order
function onTop() {
  event.preventDefault()

  const changes = []
  $.each(select_ids, function (index, id) {
    const token = tokens[id]

    if (token.locked) {
      // ignore if locked
      return
    }
    // move above highest known z-order
    if (token.locked) {
      token.zorder = -1
    } else {
      token.zorder = max_z + 1
      ++max_z
    }

    changes.push({
      id: id,
      zorder: token.zorder,
    })
  })

  writeSocket({
    OPID: 'UPDATE',
    changes: changes,
  })
}

/// Event handle for cloning the selected tokens
function onClone() {
  event.preventDefault()

  // pick random position next to mouse
  const x = mouse_x + Math.floor(Math.random() * 100) - 50
  const y = mouse_y + Math.floor(Math.random() * 100) - 50

  writeSocket({
    OPID: 'CLONE',
    ids: select_ids,
    posx: x,
    posy: y,
  })
}

/// Event handle for deleting the selected tokens
function onTokenDelete() {
  event.preventDefault()

  writeSocket({
    OPID: 'DELETE',
    tokens: select_ids,
  })
}

/// Event handle for start dragging a single dice container
function onStartDragDice(event, sides) {
  event.dataTransfer.setDragImage(drag_img, 0, 0)
  localStorage.setItem('drag_data', sides)
  //localStorage.setItem('drag_timer', '0');
}

/// Event handle for clicking a single dice container
function onResetDice(event, sides) {
  if (event.buttons == 2) {
    // reset dice position
    resetDicePos(sides)
  }
}

/// Add timer dice in the scene
function onDropTimerInScene(sides, r) {
  // save drop position for later adding
  const x = mouse_x
  const y = mouse_y

  writeSocket({
    OPID: 'CREATE',
    posx: x,
    posy: y,
    size: default_token_size,
    urls: ['/static/token_d' + sides + '.png'],
    labels: ['#' + r],
  })
}

/// Event handle for stop dragging a single dice container
function onEndDragDice(event) {
  const sides = parseInt(localStorage.getItem('drag_data'))
  if (Number.isNaN(sides)) {
    localStorage.removeItem('drag_data')
    return
  }

  const min_x = 0
  const min_y = 0
  const max_x = MAX_SCENE_WIDTH
  const max_y = MAX_SCENE_WIDTH * canvas_ratio

  // drop timer within scene
  if (min_x <= mouse_x && mouse_x <= max_x && min_y <= mouse_y && mouse_y <= max_y) {
    // query last recent roll of that die by the current player
    if (sides == 2) {
      // ignore binary die
      return
    }
    const key = sides + '_' + my_name
    var r = sides // fallback
    if (key in roll_history) {
      var r = roll_history[key]
    }

    // add timer
    onDropTimerInScene(sides, r)
  }

  localStorage.removeItem('drag_data')
}

/// Event handle for start dragging the players container
function onStartDragPlayers(event) {
  event.dataTransfer.setDragImage(drag_img, 0, 0)
  localStorage.setItem('drag_data', 'players')
}

/// Event handle for clicking the players container
function onResetPlayers(event) {
  if (event.buttons == 2) {
    // reset players position
    const target = $('#players')
    const pos = [
      parseInt(window.innerWidth * 0.5),
      parseInt(window.innerHeight - 1.5 * target.height() + 25),
    ]

    // apply position
    movePlayersTo(pos)
    localStorage.removeItem('players')
  }
}

/// Event handle for stop dragging the players container
function onEndDragPlayers(event) {
  localStorage.removeItem('drag_data')
}

/** NOT USED ANYMORE
/// Event handle for start dragging the music tools container
function onStartDragMusic(event) {
    event.dataTransfer.setDragImage(drag_img, 0, 0);
    localStorage.setItem('drag_data', 'music');
}
*/

/** NOT USED ANYMORE
/// Event handle for clicking the music tools container
function onResetMusic(event) {
    if (event.buttons == 2) {
        // reset music tools position
        var target = $('#musiccontrols');
        var x = window.innerWidth - target.width() * 1.75;
        var y = window.innerHeight * 0.5;
        
        // apply position
        moveMusicTo([x, y]);
        
        localStorage.removeItem('music');
    }
}
*/

/** NOT USED ANYMORE
/// Event handle for stop dragging the players container
function onEndDragMusic(event) {
    localStorage.removeItem('drag_data');
}
*/

/// Snaps dice container to the closest edge (from x, y)
function snapContainer(x, y, container, default_snap) {
  const w = container.width()
  const h = container.height()

  const min_x = w / 4
  const min_y = h / 4
  const max_x = window.innerWidth - w - w / 4
  const max_y = window.innerHeight - h - h / 4

  // limit pos to screen
  x = Math.max(min_x, Math.min(x, max_x))
  y = Math.max(min_y, Math.min(y, max_y))

  const dx = window.innerWidth - x // distance to right
  const dy = window.innerHeight - y // distance to bottom

  if (default_snap == 'left' || x <= Math.min(y, dx, dy)) {
    // snap to left
    return [min_x, y, 'left']
  } else if (default_snap == 'top' || y <= Math.min(x, dx, dy)) {
    // snap to top
    return [x, min_y, 'top']
  } else if (default_snap == 'right' || dx <= Math.min(x, y, dy)) {
    // snap to right
    return [max_x, y, 'right']
  } else {
    // snap to bottom
    return [x, max_y, 'bottom']
  }
}

/// Resets dice container to default position
function resetDicePos(sides) {
  localStorage.removeItem('d' + sides)

  // move to default pos
  const data = [default_dice_pos[sides][0], default_dice_pos[sides][1], 'left']
  moveDiceTo(data, sides)
}

function moveDiceTo(data, sides) {
  var icon = $('#d' + sides + 'icon')
  const rolls = $('#d' + sides + 'rolls')

  // change position
  var icon = $('#d' + sides + 'icon')
  icon.css('left', data[0])
  icon.css('top', data[1])

  const w = icon.width()
  const h = icon.height()

  // change rollbox (pos + orientation) and history (pos)
  switch (data[2]) {
    case 'left':
      rolls.css('left', w * 1.5)
      rolls.css('right', 0)
      rolls.css('top', data[1])
      rolls.css('bottom', 0)
      rolls.css('display', 'inline-flex')
      rolls.css('flex-direction', 'row')
      break
    case 'top':
      rolls.css('left', data[0])
      rolls.css('right', 0)
      rolls.css('top', h * 1.5 - w / 4)
      rolls.css('bottom', 0)
      rolls.css('display', 'flex')
      rolls.css('flex-direction', 'column')
      break
    case 'right':
      rolls.css('left', 0)
      rolls.css('right', w * 1.5)
      rolls.css('top', data[1])
      rolls.css('bottom', 0)
      rolls.css('display', 'inline-flex')
      rolls.css('flex-direction', 'row-reverse')
      break
    case 'bottom':
      rolls.css('left', data[0])
      rolls.css('right', 0)
      rolls.css('top', 0)
      rolls.css('bottom', h * 1.5 - w / 4)
      rolls.css('display', 'flex')
      rolls.css('flex-direction', 'column-reverse')
      break
  }
}

function movePlayersTo(pos) {
  const target = $('#players')
  target.css('left', pos[0])
  target.css('top', pos[1])
}

function moveMusicTo(pos) {
  const target = $('#musiccontrols')
  target.css('left', pos[0])
  target.css('top', pos[1])
}

/// Check if die is dragged over screen border or not
function isDiceAtBorder() {
  let x = null
  let y = null

  if (event.type == 'touchmove') {
    // dragging dice on mobile
    x = event.touches[0].clientX
    y = event.touches[0].clientY
  } else {
    // dragging dice on desktop
    x = event.clientX
    y = event.clientY
  }

  // make position relative to screen
  x /= window.innerWidth
  y /= window.innerHeight

  const left_or_right = x < SCREEN_BORDER_WIDTH || x > 1 - SCREEN_BORDER_WIDTH
  const top_or_bottom = y < SCREEN_BORDER_WIDTH || y > 1 - SCREEN_BORDER_WIDTH

  return left_or_right || top_or_bottom
}

/// Drag dice container to position specified by the event
function onDragDice(event) {
  //var is_drag_timer = localStorage.getItem('drag_timer');
  const sides = localStorage.getItem('drag_data')

  // NOTE: moving dice icons around is currently disabled to allow proper timer dice stuff

  /*
    if (sides == 2 || isDiceAtBorder()) {
    */
  /*
    var min_x = 0;
    var min_y = 0;
    var max_x = MAX_SCENE_WIDTH;
    var max_y = MAX_SCENE_WIDTH * canvas_ratio;
    var is_over_scene = min_x <= mouse_x && mouse_x <= max_x && min_y <= mouse_y && mouse_y <= max_y

    // move dice outside scene
    if (!is_over_scene || isDiceAtBorder()) {
        console.log('outside while drag');
        //localStorage.setItem('drag_timer', '0');
        
        // move die around edge
        var p = pickScreenPos(event);

        // drag dice box
        var target = $('#d' + sides + 'icon');

        // limit position to the screen
        var w = target.width();
        var h = target.height();
        var x = Math.max(0, Math.min(window.innerWidth - w,  p[0] - w / 2));
        var y = Math.max(0, Math.min(window.innerHeight - h, p[1] - h / 2));
        var data = [x, y];
        data = snapContainer(data[0], data[1], target, '');

        // apply position
        moveDiceTo(data, sides);
        saveDicePos(sides, data);
        
    }  */
}

/// Drag players container to position specified by the event
function onDragPlayers(event) {
  const p = pickScreenPos(event)
  const target = $('#players')

  // limit position to the screen
  const w = target.width()
  const h = target.height()
  const x = parseInt(Math.max(w / 2, Math.min(window.innerWidth - w / 2, p[0])))
  const y = parseInt(Math.max(0, Math.min(window.innerHeight - 1.5 * h + 25, p[1])))
  const pos = [x, y]

  movePlayersTo(pos)
  savePlayersPos(pos)
}

/** NOT USED ANYMORE
/// Drag music tools container to position specified by the event
function onDragMusic(event) {
    var p = pickScreenPos(event);
    var target = $('#musiccontrols');

    // limit position to the screen
    var w = target.width();
    var h = target.height();
    var x = Math.max(0, Math.min(window.innerWidth - 2 * w, p[0]));
    var y = Math.max(h/2, Math.min(window.innerHeight - h/2,  p[1]));
    var pos = [x, y];
    
    moveMusicTo(pos);
    saveMusicPos(pos);
}
*/

/// Event handle for entering a player container with the mouse
function onMouseOverPlayer(uuid) {
  over_player = uuid

  // show player menu
  const menu = $('#playermenu_' + uuid).fadeIn(1500, 0)
}

/// Event handle for leaving a player container with the mouse
function onMouseLeavePlayer(uuid) {
  over_player = null

  // hide player menu
  const menu = $('#playermenu_' + uuid).fadeOut(250, 0)
}

/// Event handle for using the mouse wheel over a player container
function onWheelPlayers() {
  const direction = -Math.sign(event.deltaY)

  if (direction != 0) {
    writeSocket({
      OPID: 'ORDER',
      name: players[over_player].name,
      direction: direction,
    })
  }
}

/// Event handle for moving a player
function onPlayerOrder(direction) {
  if (over_player != null) {
    writeSocket({
      OPID: 'ORDER',
      name: players[over_player].name,
      direction: direction,
    })
  }
}

/// Event handle for window resize
function onWindowResize(event) {
  // refresh default dice positions
  const total_dice_height = 50 * 7 // 7 dice
  const starty = window.innerHeight / 2 - total_dice_height / 2

  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
    // widely spread aligment on mobile
    default_dice_pos[20] = [15, window.innerHeight * 0.115, 'left']
    default_dice_pos[12] = [15, window.innerHeight * 0.23, 'left']
    default_dice_pos[10] = [15, window.innerHeight * 0.345, 'left']
    default_dice_pos[8] = [15, window.innerHeight * 0.46, 'left']
    default_dice_pos[6] = [15, window.innerHeight * 0.575, 'left']
    default_dice_pos[4] = [15, window.innerHeight * 0.69, 'left']
    default_dice_pos[2] = [15, window.innerHeight * 0.805, 'left']
  } else {
    // tightly packed aligment on desktop
    default_dice_pos[20] = [15, starty, 'left']
    default_dice_pos[12] = [15, starty + 50, 'left']
    default_dice_pos[10] = [15, starty + 100, 'left']
    default_dice_pos[8] = [15, starty + 150, 'left']
    default_dice_pos[6] = [15, starty + 200, 'left']
    default_dice_pos[4] = [15, starty + 250, 'left']
    default_dice_pos[2] = [15, starty + 300, 'left']
  }

  // apply dice positions
  $.each(default_dice_pos, function (sides, data) {
    var data = loadDicePos(sides)
    moveDiceTo(data, sides)
  })

  // fix players position
  const players_pos = loadPlayersPos()
  movePlayersTo(players_pos)
}

/// Load dice position from local storage, returns absolute position
function loadDicePos(sides) {
  const raw = localStorage.getItem('d' + sides)
  if (raw == null) {
    // use default position
    return default_dice_pos[sides]
  }
  let data = JSON.parse(raw)

  // calculate absolute position from precentage
  data[0] *= window.innerWidth
  data[1] *= window.innerHeight

  // handle snap
  data = snapContainer(data[0], data[1], $('#d' + sides + 'icon'), data[2])

  return data
}

/// Save dice position to local storage using percentage values
function saveDicePos(sides, data) {
  data[0] /= window.innerWidth
  data[1] /= window.innerHeight
  localStorage.setItem('d' + sides, JSON.stringify(data))
}

/// Load players position from local storage, returns absolute position
function loadPlayersPos() {
  const raw = localStorage.getItem('players')
  if (raw == null) {
    // default position: bottom center
    const target = $('#players')
    return [window.innerWidth * 0.5, window.innerHeight - target.height()]
  }
  const data = JSON.parse(raw)
  // calculate absolute position from precentage
  data[0] *= window.innerWidth
  data[1] *= window.innerHeight

  return data
}

/// Save players position to local storage using percentage values
function savePlayersPos(pos) {
  pos[0] /= window.innerWidth
  pos[1] /= window.innerHeight
  localStorage.setItem('players', JSON.stringify(pos))
}

/** NOTE USED ANYMORE
/// Save music tools position to local storage using percentage values
function saveMusicPos(pos) {
    pos[0] /= window.innerWidth;
    pos[1] /= window.innerHeight;
    localStorage.setItem('music', JSON.stringify(pos));
}
*/

/// Event handle for toggling auto movement
function onToggleAutoMove(event) {
  event.preventDefault()
  toggleAutoMove()
}

function toggleAutoMove(load = false) {
  /*
    if (load) {
        // load from browser's storage
        var raw = localStorage.getItem('allow_auto_movement');
        allow_auto_movement = JSON.parse(raw);
    } else {
        // toggle
        allow_auto_movement = !allow_auto_movement;
    }

    // show (un)locked
    if (allow_auto_movement) {
        $('#beamLock')[0].src = '/static/unlocked.png';
    } else {
        $('#beamLock')[0].src = '/static/locked.png';
    }

    // save to browser's storage
    var raw = JSON.stringify(allow_auto_movement);
    localStorage.setItem('allow_auto_movement', raw);
    */
}

function getBlobFromDataURL(url) {
  const arr = url.split(',')
  const mime = arr[0].match(/:(.*?);/)[1]
  const bstr = atob(arr[1])
  let n = bstr.length
  const u8arr = new Uint8Array(n)
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n)
  }
  return new Blob([u8arr], { type: mime })
}

function saveBlob(blob, fileName) {
  const a = document.createElement('a')
  document.body.appendChild(a)
  a.style = 'display: none'
  const url = window.URL.createObjectURL(blob)
  a.href = url
  a.download = fileName
  a.click()
  window.URL.revokeObjectURL(url)
}

function getImageBlob(img) {
  const tmp_canvas = document.createElement('canvas')
  tmp_canvas.width = img.width
  tmp_canvas.height = img.height
  const ctx = tmp_canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  url = tmp_canvas.toDataURL('image/png')

  return getBlobFromDataURL(url)
}

function ignoreBackground() {
  // load transparent image from URL
  const img = new Image()
  img.src = '/static/transparent.png'
  img.onload = function () {
    const blob = getImageBlob(img)
    const f = new FormData()
    f.append('file[]', blob, 'transparent.png')

    // upload for current scene
    uploadBackground(gm_name, game_url, f)
  }
}
