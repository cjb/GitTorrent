# [GitTorrent](http://gittorrent.org)

### The Decentralization of GitHub

**GitTorrent** is a peer-to-peer network of Git repositories being shared over BitTorrent.

To get started:
```
sudo npm install --global gittorrent
```
(You can avoid `sudo` if you place the gittorrent binaries in your `$PATH`.)

After that, you can clone a repo with:
```
git clone gittorrent://github.com/someuser/somerepo
```
Or serve your own repos with:
```
touch somerepo/.git/git-daemon-export-ok
gittorrentd
```

# Design

The design of GitTorrent has five components:  

1. A "git transport helper" that knows how to download and unpack git objects, and can be used by Git itself to perform a fetch/clone/push.  
1. A distributed hash table that advertises which git commits a node is willing to serve.  
1. A BitTorrent protocol extension that negotiates sending a packfile with needed objects to a peer  
1. A key/value store on the distributed hash table, used as a "user profile" describing a user's repositories and their latest git hashes.  
1. A method for registering friendly usernames on Bitcoin's blockchain, so that a written username can be used to find a user instead of an ugly hex string.

## 1. Git Transport Helper

When Git is asked to perform a network operation with a URL that starts with e.g. `someprotocol://`, it calls `git-remote-someprotocol` and passes the URL as an argument.  The remote helper binary is responsible for telling Git what capabilities it has, receiving commands from Git, and downloading objects into the `.git/` directory.

In GitTorrent's case, we could be asked for three styles of URL:
* `gittorrent://some.git.hosting.site/somerepo` -- we connect over `git://` to find out what the latest commit is, then perform the download using that commit's sha1.  This is kind of like a [CDN](CDN) for a git server; the actual download of objects happens via peers, but the lookup of which objects to download happens in the normal Git way.
* `gittorrent://<hex sha1>/reponame` -- the sha1 corresponds to a gittorrent user's "mutable key" (hash of their public key) on our DHT -- we look up the key, receive JSON describing the user's repositories, and then perform the download using that commit's sha1.  This doesn't use any resources outside of GitTorrent's network.
* `gittorrent://<username>` -- the username is converted into a mutable key sha1 as above.  The mapping from usernames to sha1s happens on Bitcoin's blockchain in an OP_RETURN transaction.

## 2. Distributed hash table

The bootstrap server for this DHT runs at `core.gittorrent.org:6881`.  It is a bittorrent mainline DHT.  Git SHA1s are announced by nodes who can create packfiles for them.  The clients on this DHT support dht-store (BEP 44) and use it to store mutable keys.

## 3. Protocol extension

Once a client has connected to another node, it sends a request for the SHA1 it's looking for as bencoded JSON:
```
{gittorrent: ask: "sha1"}
```
The node providing the packfile returns:
```
{gittorrent: sendTorrent: "infoHash"}
```

## 4. Key/value store
BEP 44 adds support for *mutable* and *immutable* keys.  Immutable keys are addressed by the hash of their content, but mutable keys are addressed by the hash of a crypto keypair's public key.  The owner of that keypair publishes signed updates to their public key's hash, with a sequence number to ensure the latest value is always propagated by peers.  The hash of the public key here is a GitTorrent user ID, and the value associated with that key is a JSON object describing the user's repositories in a User Profile.

### User Profile JSON format
* name (string)
* email (string)
* repositories (array)
  * name (string)
  * refs (array)
    * name (string)
    * sha1 (string)

### Mutable key file JSON format
* pub (string)
* priv (string)

## Bitcoin username registration

*This feature is not going to work on the live Bitcoin network until the OP_RETURN length is increased from 40 to 80 bytes, which will happen in Bitcoin Core v0.11, currently scheduled for release on July 1 2015.  Until then, we'll use the Bitcoin testnet, but username registrations will be discarded when the move to the live network happens.*

Our DHT can't resolve arguments over which mutable key owns a given username -- we need something capable of distributed consensus (like a blockchain) for that.

The idea of using OP_RETURN comes from telehash's blockname project, but while blockname registers domain names on the blockchain, we're registering username<->key mappings instead.  The format is:
```
@service!username!key
```
e.g.
```
@gittorrent!cjb!81e24205d4bac8496d3e13282c90ead5045f09ea
```

Note that OP_RETURN transactions are limited to 80 bytes, which limits usernames in this scheme to 27 bytes.

As a convenience, this repository will include a database of registered usernames that is updated regularly.  This doesn't make GitTorrent any more centralized -- you can run the same scripts yourself on a downloaded blockchain to make sure that this repository does not lie.  This is just to save everyone from downloading tens of gigabytes of blockchain to process.

By the way, storing full Bitcoin history is not necessary.  We just need to scan every transaction once, and can discard each transaction after we've scanned it once and determined whether it contained a valid username registration that we record.  We just need to scan through all unprocessed blockchain transactions once, and record where we got up to so that we don't have to look at them again after that.

## Contributing

Please send pull requests!  Even changes to the design of GitTorrent are welcome and encouraged; nothing is set in stone.

#### JavaScript Standard Style

GitTorrent uses [JavaScript Standard Style](https://github.com/feross/standard).

[![js-standard-style](https://raw.githubusercontent.com/feross/standard/master/badge.png)](https://github.com/feross/standard)

#### Enable debug logs

In **node**, enable debug logs by setting the `DEBUG` environment variable to the name of the
module you want to debug (e.g. `bittorrent-protocol`, or `*` to print **all logs**).

### License

MIT. Copyright (c) [Chris Ball](http://printf.net).
