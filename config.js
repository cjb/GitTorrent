module.exports = require('rc')('gittorrent', {
  dht: {
    bootstrap: [
      'dht.gittorrent.org:6881',
      'core.gittorrent.org:6881'
    ],
    listen: 6881,
    announce: 30000
  },
  key: 'ed25519.key'
})
