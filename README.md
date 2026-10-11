# Feishin - jukebox fork for the WiiM bridge

Fork of [jeffvli/feishin](https://github.com/jeffvli/feishin) with a rewritten jukebox
player. It turns Feishin's web build into a remote control for a WiiM amplifier.

> **This fork only makes sense together with
> [navidrome-wiim-bridge](https://github.com/m8-t/navidrome-wiim-bridge).**
> The changes are built for and tested against that bridge and nothing else. If you do
> not run the bridge, use upstream Feishin.

The branch `jukebox-bridge` is the fork's default branch and the only one that matters.
Everything else is untouched upstream history. For Feishin itself, its features and its
documentation, see the upstream repository.

## What it is for

The bridge sits between Navidrome and a WiiM amplifier. It plays the original files of
the library on the WiiM and keeps the play queue inside the device, so the WiiM's
physical remote works and the music does not depend on an open app. The bridge is
controlled through the "jukebox" part of the Subsonic protocol: the client plays
nothing itself and only sends the song list and commands.

Feishin has a jukebox player type, but stock Feishin 1.17 does not fit that model:

- It keeps the queue to itself and hands the server only the current and the next
  track. The device then knows two tracks, and the remote's next and previous cannot
  go any further.
- It only asks the server for its state while it thinks a song is playing, and it does
  not follow what it gets back. A pause or a skip made on the remote never shows up.
- Its web build switches the jukebox player off.

## What the patch set changes

| Change | Effect |
|---|---|
| The whole queue is pushed to the server, in chunks of 50 ids, and queue edits are sent as they happen | the device knows everything that is queued |
| The server is polled all the time and Feishin follows it: current track, play state, position, volume | the remote, the phone page and Feishin show the same thing |
| The server's queue wins. At startup, and whenever it changes from outside, Feishin loads it instead of pushing its own | opening Feishin never interrupts music another controller started |
| Commands that only repeat what the server already reports are dropped; so are the seek and volume events Feishin's own store fires at page load and on every song change | a page reload does not restart the song |
| Mute is synced through an extension the bridge offers (`muted` in the status, a `setMute` action). It is used only when the server reports the field | mute on the remote and in Feishin agree |
| The web build keeps the jukebox player | usable in a browser |

Volume is taken from the device at startup, never pushed to it.

The changes live in `src/renderer/features/player/audio-player/` (the engine, the
player component and a helper module with tests) plus small edits in the player store
and the Subsonic types. `pnpm run test:jukebox` runs the helper tests.

## Why not Feishin's own DLNA casting?

Feishin can cast to a WiiM directly over DLNA, and that also sends the original file.
Sound quality is the same on both paths. The difference is where the queue lives.

| | DLNA cast from Feishin | Jukebox through the bridge |
|---|---|---|
| Audio | original file | original file |
| Where the queue lives | in the Feishin app | in the WiiM |
| Close the app | the music ends with the current track | the music keeps playing |
| Remote: next | ignored | next track |
| Remote: previous | restarts the track | previous track |
| Track changes | a gap of about a second | gapless |
| Works in a browser or on a phone | no, the desktop app only | yes |

These are results from a test with Feishin 1.17.0 and a WiiM Amp Ultra, not general
claims about DLNA.

## Running it

The image contains the web build behind nginx, like upstream's.

```
podman run --rm -p 9180:9180 \
  -e SERVER_URL=https://bridge.example.org \
  -e SERVER_TYPE=navidrome \
  -e SERVER_NAME=WiiM \
  -e SERVER_LOCK=true \
  ghcr.io/m8-t/feishin-jukebox:1.17.0-jukebox
```

`SERVER_URL` is the address of the bridge, not of Navidrome. Log in with your
Navidrome user and choose "Jukebox" as the player in the settings. With the web player
selected instead, Feishin plays on the computer and the bridge simply passes the
requests on to Navidrome.

If the page is served over HTTPS, the bridge must be reachable over HTTPS too. A
browser refuses to call a plain HTTP address from an HTTPS page.

`GET /healthz` answers `ok` and is not written to the access log.

For Kubernetes, the bridge's repository has manifests that deploy this image together
with the bridge:
[navidrome-wiim-bridge/deploy/kubernetes](https://github.com/m8-t/navidrome-wiim-bridge/tree/main/deploy/kubernetes).

## Limits

- Web build only. The desktop app is not patched.
- Taking a queue over from the server switches Feishin's shuffle off, because the
  server's order is the real one.
- Switching shuffle on while a song plays replaces the queue on the device. There is a
  gap of a second or two, then the song continues where it was (bridge 0.2.1 or newer;
  older bridges restart the song from the beginning).
- Repeat modes are not sent to the server.
- Clicking the track that is already playing does nothing. Seek to the start instead.
- Portrait phone screens are not usable; that is upstream's layout. The bridge serves
  its own small phone page for that.

## How the image is built

The fork follows upstream releases without being rebased by hand each time:

- The branch stays on the upstream tag its commits were written against.
- A workflow takes the difference between that tag and the branch as a patch, checks
  out the upstream release to build, applies the patch, runs the jukebox tests and the
  type check, and builds the web bundle.
- A nightly job looks for a new upstream release and starts a build on it. The image
  tag is the upstream version with the suffix `-jukebox`.
- If the patch no longer applies to a new release, the build fails and no image is
  published. The branch then needs a real rebase.

## License

[GNU General Public License v3.0](LICENSE), the same as upstream.
