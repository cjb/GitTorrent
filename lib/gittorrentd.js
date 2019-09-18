#!/usr/bin/env node

var DHT = require('bittorrent-dht')
var EC = require('elliptic').ec
var ed25519 = new EC('ed25519')
var exec = require('child_process').exec
var glob = require('glob')
var fs = require('fs')
var hat = require('hat')
var net = require('net')
var Protocol = require('bittorrent-protocol')
var spawn = require('child_process').spawn
var ut_gittorrent = require('ut_gittorrent')
var ut_metadata = require('ut_metadata')
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

var dht = new DHT({
  bootstrap: config.dht.bootstrap
})
dht.listen(config.dht.listen)

var announcedRefs = {
}
var userProfile = {
  repositories: {}
}

var key = create_or_read_keyfile()

function create_or_read_keyfile () {
  if (!fs.existsSync(config.key)) {
    var keypair = new EC('ed25519').genKeyPair()
    fs.writeFileSync(config.key, JSON.stringify({
      pub: keypair.getPublic('hex'),
      priv: keypair.getPrivate('hex')
    }))
  }

  // Okay, now the file exists, whether created here or not.
  var key = JSON.parse(fs.readFileSync(config.key).toString())
  return ed25519.keyPair({
    priv: key.priv,
    privEnc: 'hex',
    pub: key.pub,
    pubEnc: 'hex'
  })
}

function bpad (n, buf) {
  if (buf.length === n) return buf
  if (buf.length < n) {
    var b = new Buffer(n)
    buf.copy(b, n - buf.length)
    for (var i = 0; i < n - buf.length; i++) b[i] = 0
    return b
  }
}

var head = ''

dht.on('ready', function () {
  // Spider all */.git dirs and announce all refs.
  var repos = glob.sync('*/{,.git/}git-daemon-export-ok', { strict: false })
  var count = repos.length
  repos.forEach(function (repo) {
    console.log('in repo ' + repo)
    repo = repo.replace(/git-daemon-export-ok$/, '')
    console.log(repo)

    var reponame = repo.replace(/\/.git\/$/, '')
    userProfile.repositories[reponame] = {}

    var ls = git.ls(repo, function (sha, ref) {
      // FIXME: Can't pull in too many branches, so only do heads for now.
      if (ref !== 'HEAD' && !ref.match(/^refs\/heads\//)) {
        return
      }
      if (ref === 'refs/heads/master') {
        head = sha
      }
      userProfile.repositories[reponame][ref] = sha
      if (!announcedRefs[sha]) {
        console.log('Announcing ' + sha + ' for ' + ref + ' on repo ' + repo)
        announcedRefs[sha] = repo
        dht.announce(sha, config.dht.announce, function (err) {
          if (err !== null) {
            console.log('Announced ' + sha)
          }
        })
      }
    })
    ls.stdout.on('end', function () {
      count--
      if (count <= 0) {
        publish_mutable_key()
      }
    })
    ls.on('exit', function (err) {
      if (err) {
        die(err)
      }
    })
  })

  function publish_mutable_key () {
    var json = JSON.stringify(userProfile)
    if (json.length > 950) {
      console.error("Can't publish mutable key: doesn't fit in 950 bytes.")
      return false
    }
    var value = new Buffer(json.length)
    value.write(json)
    var sig = key.sign(value)
    var opts = {
      k: bpad(32, Buffer(key.getPublic().x.toArray())),
      seq: 0,
      v: value,
      sig: Buffer.concat([
        bpad(32, Buffer(sig.r.toArray())),
        bpad(32, Buffer(sig.s.toArray()))
      ])
    }
    console.log(json)
    dht.put(opts, function (errors, hash) {
      console.error('errors=', errors)
      console.log('hash=', hash.toString('hex'))
    })
  }

  net.createServer(function (socket) {
    var wire = new Protocol()
    wire.use(ut_gittorrent())
    wire.use(ut_metadata())
    socket.pipe(wire).pipe(socket)
    wire.on('handshake', function (infoHash, peerId) {
      console.log('Received handshake for ' + infoHash.toString('hex'))
      var myPeerId = new Buffer('-WW' + VERSION + '-' + hat(48), 'utf8')
      wire.handshake(new Buffer(infoHash), new Buffer(myPeerId))
    })
    wire.ut_gittorrent.on('generatePack', function (sha) {
      console.error('calling git pack-objects for ' + sha)
      if (!announcedRefs[sha]) {
        console.error('Asked for an unknown sha: ' + sha)
        return
      }
      var directory = announcedRefs[sha]
      var have = null
      if (sha !== head) {
        have = head
      }
      var pack = git.upload_pack(directory, sha, have)
      pack.stderr.pipe(process.stderr)
      pack.on('ready', function () {
        var filename = sha + '.pack'
        var stream = fs.createWriteStream(filename)
        pack.stdout.pipe(stream)
        stream.on('close', function () {
          console.error('Finished writing ' + filename)
          var webtorrent = new WebTorrent({
            dht: { bootstrap: config.dht.bootstrap },
            tracker: false
          })
          webtorrent.seed(filename, function onTorrent (torrent) {
            console.error(torrent.infoHash)
            wire.ut_gittorrent.sendTorrent(torrent.infoHash)
          })
        })
      })
      pack.on('exit', function (code) {
        if (code !== 0) {
          console.error('git-upload-pack process exited with code ' + code)
        }
      })
    })
  }).listen(config.dht.announce)
})
