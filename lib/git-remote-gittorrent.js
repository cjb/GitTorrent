#!/usr/bin/env node

var Chalk = require('chalk')
var DHT = require('bittorrent-dht')
var exec = require('child_process').exec
var hat = require('hat')
var magnet = require('magnet-uri')
var prettyjson = require('prettyjson')
var spawn = require('child_process').spawn
var Swarm = require('bittorrent-swarm')
var ut_gittorrent = require('ut_gittorrent')
var WebTorrent = require('webtorrent')
var zeroFill = require('zero-fill')
var config = require('./config')
var git = require('./git')

// BitTorrent client version string (used in peer ID).
// Generated from package.json major and minor version. For example:
//   '0.16.1' -> '0016'
//   '1.2.5' -> '0102'
//
var VERSION = require('./package.json').version
  .match(/([0-9]+)/g).slice(0, 2).map(zeroFill(2)).join('')

function die (error) {
  console.error(error)
  process.exit(1)
}

// Gotta enable color manually because stdout isn't a tty.
var chalk = new Chalk.constructor({ enabled: true })

var dht = new DHT({
  bootstrap: config.dht.bootstrap
})

// After building a dictionary of references (sha's to branch names), responds
// to git's "list" and "fetch" commands.
function talk_to_git (refs) {
  process.stdin.setEncoding('utf8')
  var didFetch = false
  process.stdin.on('readable', function () {
    var chunk = process.stdin.read()
    if (chunk === 'capabilities\n') {
      process.stdout.write('fetch\n\n')
    } else if (chunk === 'list\n') {
      Object.keys(refs).forEach(function (branch, i) {
        process.stdout.write(refs[branch] + ' ' + branch + '\n')
      })
      process.stdout.write('\n')
    } else if (chunk && chunk.search(/^fetch/) !== -1) {
      didFetch = true
      chunk.split(/\n/).forEach(function (line) {
        if (line === '') {
          return
        }
        // Format: "fetch sha branch"
        line = line.split(/\s/)
        get_infohash(line[1], line[2])
      })
    } else if (chunk && chunk !== '' && chunk !== '\n') {
      console.warn('unhandled command: "' + chunk + '"')
    }
    if (chunk === '\n') {
      process.stdout.write('\n')
      if (!didFetch) {
        // If git already has all the refs it needs, we should exit now.
        process.exit()
      }
    }
  })
  process.stdout.on('error', function () {
    // stdout was closed
  })
}

var remotename = process.argv[2]
var url = process.argv[3]
var matches = url.match(/gittorrent:\/\/([a-f0-9]{40})\/(.*)/)
var refs = {} // Maps branch names to sha's.
if (matches) {
  var key = matches[1]
  var reponame = matches[2]
  if (remotename.search(/^gittorrent:\/\//) !== -1) {
    remotename = key
  }
  dht.on('ready', function () {
    var val = new Buffer(key, 'hex')
    dht.get(val, function (err, res) {
      if (err) {
        return console.error(err)
      }
      var json = res.v.toString()
      var repos = JSON.parse(json)
      console.warn('\nMutable key ' + chalk.green(key) + ' returned:\n' +
                   prettyjson.render(repos, { keysColor: 'yellow', valuesColor: 'green' }) + '\n')
      talk_to_git(repos.repositories[reponame])
    })
  })
} else {
  url = url.replace(/^gittorrent:/i, 'git:')
  var ls = git.ls(url, function (sha, branch) {
    refs[branch] = sha
  })
  ls.on('exit', function (err) {
    if (err) {
      die(err)
    }
    dht.on('ready', function () {
      talk_to_git(refs)
    })
  })
}

var fetching = {} // Maps shas -> {got: <bool>, swarm, branches: [...]}
var todo = 0 // The number of sha's we have yet to fetch. We will not exit
// until this equals zero.
dht.on('peer', function (addr, hash, from) {
  var goal = fetching[hash]
  if (!goal.peer) {
    todo++
    goal.peer = true
  }
  goal.swarm.addPeer(addr)
})

function get_infohash (sha, branch) {
  branch = branch.replace(/^refs\/(heads\/)?/, '')
  branch = branch.replace(/\/head$/, '')

  // We use console.warn (stderr) because git ignores our writes to stdout.
  console.warn('Okay, we want to get ' + chalk.yellow(branch) + ': ' +
               chalk.green(sha))

  if (sha in fetching) {
    fetching[sha].branches.push(branch)
    // Prevent starting a redundant lookup
    return
  }

  var info = { got: false, peer: false, swarm: null, branches: [branch] }
  fetching[sha] = info

  var magnetUri = 'magnet:?xt=urn:btih:' + sha
  var parsed = magnet(magnetUri)
  dht.lookup(parsed.infoHash)

  var peerId = new Buffer('-WW' + VERSION + '-' + hat(48), 'utf8')
  info.swarm = new Swarm(parsed.infoHash, peerId)
  info.swarm.on('wire', function (wire, addr) {
    console.warn('\nAdding swarm peer: ' + chalk.green(addr) + ' for ' +
                 chalk.green(parsed.infoHash))
    wire.use(ut_gittorrent())
    wire.ut_gittorrent.on('handshake', function () {
      wire.ut_gittorrent.ask(parsed.infoHash)
    })
    wire.ut_gittorrent.on('receivedTorrent', function (infoHash) {
      var client = new WebTorrent({
        dht: {
          bootstrap: config.dht.bootstrap
        },
        tracker: false
      })
      client.download(infoHash, function (torrent) {
        console.warn('Downloading ' + chalk.green(torrent.files[0].path) +
                     ' with infohash: ' + chalk.green(infoHash) + '\n')
        torrent.on('done', function (done) {
          console.warn('done downloading: ' + chalk.green(torrent.files[0].path))
          fetching[sha].got = true

          var stream = torrent.files[0].createReadStream()
          var unpack = spawn('git', ['index-pack', '--stdin', '-v', '--fix-thin'])
          stream.pipe(unpack.stdin)
          unpack.stderr.pipe(process.stderr)
          unpack.on('exit', function (code) {
            todo--
            if (todo <= 0) {
              // These writes are actually necessary for git to finish
              // checkout.
              process.stdout.write('\n\n')
              process.exit()
            }
          })
        })
      })
    })
  })
}
