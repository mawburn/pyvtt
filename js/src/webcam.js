/// Settings for webcam usage
const webcam_constraints = {
    audio: false,
    video: {
        width: 1600, height: 900
    }
};

const screenshare_constraints = {
    video: {
        cursor: "never",
        logicalSurface: true
    },
    audio: false
}


function initWebcam() {
    closeDrawing();
    
    navigator.mediaDevices.getUserMedia(webcam_constraints)
    .then(function(stream) { onStreamReady(stream); })
    .catch(function(err) {
        console.error(err.toString());
        showError('NO WEBCAM FOUND');
    });
}

function initScreenShare() {
    closeWebcam();
    closeDrawing();
    
    navigator.mediaDevices.getDisplayMedia(screenshare_constraints)
    .then(function(stream) { onStreamReady(stream); })
    .catch(function(err) {
        console.error(err.toString());
        showError('SCREENSHARE NOT AVAILABLE');
    });
}

function onStreamReady(stream) {
    window.stream = stream;
    $('#video')[0].srcObject = stream;
    $('#camerapreview').fadeIn(500);
    
    $('#applySnapshot').hide();
}

function onTakeSnapshot() {
    // apply video resolution to canvas
    var preview = $('#snapshot')[0]
    preview.width  = webcam_constraints.video.width;
    preview.height = webcam_constraints.video.height;

    // draw video snapshot onto canvas
    var context = preview.getContext('2d');
    context.clearRect(0, 0, preview.width, preview.height);
    context.drawImage($('#video')[0], 0, 0, preview.width, preview.height);
    
    $('#applySnapshot').fadeIn(100);
}

function onApplyBackground() {
    showInfo('LOADING');
    
    // fetch JPEG-data from canvas
    var preview = $('#snapshot')[0]
    var url = preview.toDataURL("image/jpeg");

    // prepare upload form data
    var blob = getBlobFromDataURL(url);
    var f = new FormData();
    f.append('file[]', blob, 'snapshot.jpeg');

    // upload for current scene
    uploadBackground(gm_name, game_url, f);
}

function closeWebcam() {
    $('#camerapreview').fadeOut(500);
    
    $('#video')[0] = null;
    window.stream  = null;    
    var preview = $('#snapshot')[0];
    var context = preview.getContext('2d');
    context.clearRect(0, 0, preview.width, preview.height);
}

function togglePreview(id) {
    var target = $(id);
    if (target.hasClass('largepreview')) {
        // reset to preview
        target.removeClass('largepreview');
        target.css('height', 180);
    } else {
        // enlarge
        target.addClass('largepreview');
        target.css('width', 'auto');
        target.css('height', window.innerHeight - 100);
    }
}
