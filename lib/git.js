#!/usr/bin/env node

var spawn = require('child_process').spawn

// Returns a process running `git ls-remote <url>` that calls `with_ref` on
// each parsed reference. The url may point to a local repository.
function ls (url, withRef) {
  var ls = spawn('git', ['ls-remote', url])
  ls.stdout.on('data', function (lines) {
    lines.toString().split('\n').forEach(function (line) {
      if (!line || line === '') {
        return
      }
      line = line.split('\t')
      var sha = line[0]
      var branch = line[1]
      if (sha.length !== 40) {
        console.warn('[git ls-remote] expected a 40-byte sha: ' + sha + '\n')
        console.warn('[git ls-remote] on line: ' + line.join('\t'))
      }
      withRef(sha, branch)
    })
  })
  return ls
}

function pad4 (num) {
  num = num.toString(16)
  while (num.length < 4) {
    num = '0' + num
  }
  return num
}

// Invokes `$ git-upload-pack --strict <dir>`, communicates haves and wants and
// emits 'ready' when stdout becomes a pack file stream.
function uploadPack (dir, want, have) {
  // reference:
  // https://github.com/git/git/blob/b594c975c7e865be23477989d7f36157ad437dc7/Documentation/technical/pack-protocol.txt#L346-L393
  var upload = spawn('git-upload-pack', ['--strict', dir])
  writeln('want ' + want)
  writeln()
  if (have) {
    writeln('have ' + have)
    writeln()
  }
  writeln('done')

  // We want to read git's output one line at a time, and not read any more
  // than we have to. That way, when we finish discussing wants and haves, we
  // can pipe the rest of the output to a stream.
  //
  // We use `mode` to keep track of state and formulate responses. It returns
  // `false` when we should stop reading.
  var mode = list
  upload.stdout.on('readable', function () {
    while (true) {
      var line = getline()
      if (line === null) {
        return // to wait for more output
      }
      if (!mode(line)) {
        upload.stdout.removeAllListeners('readable')
        upload.emit('ready')
        return
      }
    }
  })

  var getLineLen = null
  // Extracts exactly one line from the stream. Uses `getLineLen` in case the
  // whole line could not be read.
  function getline () {
    // Format: '####line' where '####' represents the length of 'line' in hex.
    if (!getLineLen) {
      getLineLen = upload.stdout.read(4)
      if (getLineLen === null) {
        return null
      }
      getLineLen = parseInt(getLineLen, 16)
    }

    if (getLineLen === 0) {
      return ''
    }

    // Subtract by the four we just read, and the terminating newline.
    var line = upload.stdout.read(getLineLen - 4 - 1)
    if (!line) {
      return null
    }
    getLineLen = null
    upload.stdout.read(1) // And discard the newline.
    return line.toString()
  }

  // First, the server lists the refs it has, but we already know from
  // `git ls-remote`, so wait for it to signal the end.
  function list (line) {
    if (line === '') {
      mode = have ? ackObjectsContinue : waitForNak
    }
    return true
  }

  // If we only gave wants, git should respond with 'NAK', then the pack file.
  function waitForNak (line) {
    return line !== 'NAK'
  }

  // With haves, we wait for 'ACK', but only if not ending in 'continue'.
  function ackObjectsContinue (line) {
    return !(line.search(/^ACK/) !== -1 && line.search(/continue$/) === -1)
  }

  // Writes one line to stdin so git-upload-pack can understand.
  function writeln (line) {
    if (line) {
      var len = pad4(line.length + 4 + 1) // Add one for the newline.
      upload.stdin.write(len + line + '\n')
    } else {
      upload.stdin.write('0000')
    }
  }

  return upload
}

module.exports = { ls: ls, upload_pack: uploadPack }
