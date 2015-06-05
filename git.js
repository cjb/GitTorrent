#!/usr/bin/env node

var spawn = require('child_process').spawn

// Returns a process running `git ls-remote <url>` that calls `with_ref` on
// each parsed reference. The url may point to a local repository.
function ls (url, with_ref) {
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
      with_ref(sha, branch)
    })
  })
  return ls
}

module.exports = {ls: ls}
