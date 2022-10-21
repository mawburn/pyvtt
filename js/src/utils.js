function brightnessByColor(color) {
  color = '' + color
  const isHEX = color.indexOf('#') === 0
  const isRGB = color.indexOf('rgb') === 0

  let m
  let r
  let g
  let b

  if (isHEX) {
    m = color.substr(1).match(color.length === 7 ? /(\S{2})/g : /(\S{1})/g)
    if (m) {
      r = parseInt(m[0], 16)
      g = parseInt(m[1], 16)
      b = parseInt(m[2], 16)
    }
  }
  if (isRGB) {
    m = color.match(/(\d+){3}/g)
    if (m) {
      r = m[0]
      g = m[1]
      b = m[2]
    }
  }
  if (typeof r !== 'undefined') return (r * 299 + g * 587 + b * 114) / 1000
}

function rgbToHsl(r, g, b) {
  ;(r /= 255), (g /= 255), (b /= 255)
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)

  let h
  let s
  const l = (max + min) / 2

  if (max === min) {
    h = s = 0 // achromatic
  } else {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0)
        break
      case g:
        h = (b - r) / d + 2
        break
      case b:
        h = (r - g) / d + 4
        break
    }
    h /= 6
  }

  return [h, s, l]
}

/// Get HSL from RGB
function getHsl(color) {
  const r = parseInt(color.substr(1, 2), 16)
  const g = parseInt(color.substr(3, 2), 16)
  const b = parseInt(color.substr(5, 2), 16)
  return rgbToHsl(r, g, b)
}
