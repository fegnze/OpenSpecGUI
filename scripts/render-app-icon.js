'use strict';

var fsPromises = require('node:fs/promises');
var path = require('node:path');
var electron = require('electron');

var app = electron.app;
var BrowserWindow = electron.BrowserWindow;
var sourcePath = path.resolve(process.argv[2]);
var targetPath = path.resolve(process.argv[3]);

function createRendererHtml(sourceDataUrl) {
    var sourceJson = JSON.stringify(sourceDataUrl);

    return [
        '<!doctype html>',
        '<html><body><canvas id="icon" width="1024" height="1024"></canvas>',
        '<script>',
        'function removeConnectedBackground(context) {',
        '  var imageData = context.getImageData(0, 0, 1024, 1024);',
        '  var pixels = imageData.data;',
        '  var visited = new Uint8Array(1024 * 1024);',
        '  var queue = new Int32Array(1024 * 1024);',
        '  var head = 0;',
        '  var tail = 0;',
        '  function isBackground(index) {',
        '    var pixel = index * 4;',
        '    var red = pixels[pixel];',
        '    var green = pixels[pixel + 1];',
        '    var blue = pixels[pixel + 2];',
        '    var lightness = (red + green + blue) / 3;',
        '    var chroma = Math.max(red, green, blue) - Math.min(red, green, blue);',
        '    return lightness >= 175 && chroma <= 18;',
        '  }',
        '  function enqueue(index) {',
        '    if (!visited[index] && isBackground(index)) {',
        '      visited[index] = 1;',
        '      queue[tail] = index;',
        '      tail += 1;',
        '    }',
        '  }',
        '  for (var edge = 0; edge < 1024; edge += 1) {',
        '    enqueue(edge);',
        '    enqueue(1023 * 1024 + edge);',
        '    enqueue(edge * 1024);',
        '    enqueue(edge * 1024 + 1023);',
        '  }',
        '  while (head < tail) {',
        '    var index = queue[head];',
        '    var x = index % 1024;',
        '    var y = Math.floor(index / 1024);',
        '    head += 1;',
        '    if (x > 0) enqueue(index - 1);',
        '    if (x < 1023) enqueue(index + 1);',
        '    if (y > 0) enqueue(index - 1024);',
        '    if (y < 1023) enqueue(index + 1024);',
        '  }',
        '  for (var index = 0; index < visited.length; index += 1) {',
        '    if (visited[index]) pixels[index * 4 + 3] = 0;',
        '  }',
        '  context.putImageData(imageData, 0, 0);',
        '}',
        'window.renderIcon = async function () {',
        '  var image = new Image();',
        '  image.src = ' + sourceJson + ';',
        '  await image.decode();',
        '  var sourceCanvas = document.createElement("canvas");',
        '  sourceCanvas.width = 1024;',
        '  sourceCanvas.height = 1024;',
        '  var sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });',
        '  sourceContext.drawImage(image, 0, 0, 1024, 1024);',
        '  removeConnectedBackground(sourceContext);',
        '  var canvas = document.getElementById("icon");',
        '  var context = canvas.getContext("2d");',
        '  context.clearRect(0, 0, 1024, 1024);',
        '  context.beginPath();',
        '  context.roundRect(39, 36, 946, 954, 160);',
        '  context.clip();',
        '  context.drawImage(sourceCanvas, 0, 0);',
        '  return canvas.toDataURL("image/png");',
        '};',
        '</script></body></html>'
    ].join('');
}

async function render() {
    var source = await fsPromises.readFile(sourcePath);
    var sourceDataUrl = 'data:image/jpeg;base64,' + source.toString('base64');
    var window = new BrowserWindow({
        show: false,
        transparent: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(createRendererHtml(sourceDataUrl)));
    var pngDataUrl = await window.webContents.executeJavaScript('window.renderIcon()');
    var png = Buffer.from(pngDataUrl.slice(pngDataUrl.indexOf(',') + 1), 'base64');

    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.writeFile(targetPath, png);
    window.destroy();
}

app.disableHardwareAcceleration();
app.whenReady()
    .then(render)
    .then(function () {
        app.quit();
    })
    .catch(function (error) {
        console.error(error);
        app.exit(1);
    });
