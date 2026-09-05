"use strict";

// Machine-readable server state exporting necessary data for the website's data
// rendering stuff. In hindsight this *could* have been a mod but honestly who
// wants to write Java?
//
// Files land under  world/tfgm-export/ relative to the server's working directory.
// The launcher runs with cwd = server dir, so a relative path resolves into the
// save area, which is generated state and not actually shipped in the serverpack.
//
// Outputs:
//   world/tfgm-export/live.json, snapshot, rewritten atomically every ~5s
//   world/tfgm-export/events.jsonl, append-only join/leave/death feed
//
// For the purposes of recording, I've elected to include advancements and
// per-player stats here. Data service reads world/advancements/*.json and
// world/stats/*.json directly but player coordinates are omitted by design. Public
// data does not need to be *all* public.

const Files = Java.loadClass("java.nio.file.Files");
const Paths = Java.loadClass("java.nio.file.Paths");
const OpenOption = Java.loadClass("java.nio.file.StandardOpenOption");
const CopyOption = Java.loadClass("java.nio.file.StandardCopyOption");
const JavaString = Java.loadClass("java.lang.String");
const System = Java.loadClass("java.lang.System");

const SCHEMA_VERSION = 1;
const EXPORT_DIR = "world/tfgm-export";
const LIVE_PATH = EXPORT_DIR + "/live.json";
const LIVE_TMP = EXPORT_DIR + "/live.json.tmp";
const EVENTS_PATH = EXPORT_DIR + "/events.jsonl";

const WRITE_INTERVAL = 100; // ticks between live.json writes (~5s at 20 TPS)
const MSPT_WINDOW = 100; // ticks averaged into the reported MSPT
const UTF8 = "UTF-8";

let ticksUntilWrite = 0;
let startEpochMs = 0;
let lastTickNano = 0;
const tickMs = []; // rolling per-tick durations, newest pushed, capped at MSPT_WINDOW

function ensureDir() {
  const dir = Paths.get(EXPORT_DIR);
  if (!Files.exists(dir)) {
    Files.createDirectories(dir);
  }
}

// tmp-write then rename: a same-filesystem move is atomic on Linux, so the data
// service never reads a half-written live.json.
function writeLive(text) {
  const bytes = new JavaString(text).getBytes(UTF8);
  const tmp = Paths.get(LIVE_TMP);
  Files.write(tmp, bytes);
  Files.move(tmp, Paths.get(LIVE_PATH), CopyOption.REPLACE_EXISTING);
}

function appendEvent(obj) {
  try {
    ensureDir();
    const line = JSON.stringify(obj) + "\n";
    const bytes = new JavaString(line).getBytes(UTF8);
    Files.write(
      Paths.get(EVENTS_PATH),
      bytes,
      OpenOption.CREATE,
      OpenOption.APPEND,
    );
  } catch (e) {
    console.error("[tfgm-export] failed to append event: " + e);
  }
}

function meanMspt() {
  if (tickMs.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < tickMs.length; i++) {
    sum += tickMs[i];
  }
  return sum / tickMs.length;
}

// TFC calendar is the source of truth for in-game day/season. I'm making this
// guarded so a TFC API change, which is likely and I don't care to keep up to
// date, degrades to nulls instead of killing the tick loop.
function worldTime(server) {
  const overworld = server.overworld;
  const out = {
    day: null,
    timeOfDay: null,
    season: null,
    weather: "clear",
  };
  try {
    out.timeOfDay = Number(overworld.getDayTime() % 24000);
  } catch (e) {
    /* keep null */
  }
  try {
    const calendar = TFC.calendar.getCalendar(overworld);
    const ticks = calendar.getCalendarTicks();
    out.day = Math.floor(Number(ticks) / 24000);
    const month = TFC.calendar.getMonthOfYear(
      ticks,
      calendar.getCalendarDaysInMonth(),
    );
    out.season = String(month.getSeason().name()).toLowerCase();
  } catch (e) {
    /* TFC unavailable; leave day/season null */
  }
  try {
    if (overworld.isThundering()) {
      out.weather = "thunder";
    } else if (overworld.isRaining()) {
      out.weather = "rain";
    }
  } catch (e) {
    /* keep clear */
  }
  return out;
}

function playerList(server) {
  const players = server.players;
  const out = [];
  for (let i = 0; i < players.size(); i++) {
    const p = players.get(i);
    let dimension = null;
    try {
      dimension = String(p.level.dimension().location());
    } catch (e) {
      /* leave null */
    }
    out.push({
      name: String(p.username),
      uuid: String(p.getUuid()),
      dimension: dimension,
    });
  }
  return out;
}

function buildLive(server) {
  const mspt = meanMspt();
  const tps = mspt > 0 ? Math.min(20, 1000 / mspt) : 20;
  const players = playerList(server);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: Number(System.currentTimeMillis()),
    server: {
      uptimeSeconds:
        startEpochMs > 0
          ? Math.floor(
              (Number(System.currentTimeMillis()) - startEpochMs) / 1000,
            )
          : 0,
      mspt: Math.round(mspt * 10) / 10,
      tps: Math.round(tps * 10) / 10,
      onlineCount: players.length,
    },
    world: worldTime(server),
    players: players,
  };
}

ServerEvents.loaded((event) => {
  startEpochMs = Number(System.currentTimeMillis());
  try {
    ensureDir();
  } catch (e) {
    console.error("[tfgm-export] could not create export dir: " + e);
  }
  appendEvent({
    schemaVersion: SCHEMA_VERSION,
    ts: startEpochMs,
    type: "server_start",
  });
});

ServerEvents.tick((event) => {
  const now = Number(System.nanoTime());
  if (lastTickNano > 0) {
    tickMs.push((now - lastTickNano) / 1000000);
    if (tickMs.length > MSPT_WINDOW) {
      tickMs.shift();
    }
  }
  lastTickNano = now;

  if (ticksUntilWrite > 0) {
    ticksUntilWrite--;
    return;
  }
  ticksUntilWrite = WRITE_INTERVAL - 1;

  try {
    ensureDir();
    writeLive(JSON.stringify(buildLive(event.server)));
  } catch (e) {
    console.error("[tfgm-export] failed to write live.json: " + e);
  }
});

PlayerEvents.loggedIn((event) => {
  appendEvent({
    schemaVersion: SCHEMA_VERSION,
    ts: Number(System.currentTimeMillis()),
    type: "join",
    player: String(event.player.username),
    uuid: String(event.player.getUuid()),
  });
});

PlayerEvents.loggedOut((event) => {
  appendEvent({
    schemaVersion: SCHEMA_VERSION,
    ts: Number(System.currentTimeMillis()),
    type: "leave",
    player: String(event.player.username),
    uuid: String(event.player.getUuid()),
  });
});

PlayerEvents.death((event) => {
  let cause = "unknown";
  try {
    cause = String(event.source.getMsgId());
  } catch (e) {
    /* keep unknown */
  }
  appendEvent({
    schemaVersion: SCHEMA_VERSION,
    ts: Number(System.currentTimeMillis()),
    type: "death",
    player: String(event.player.username),
    uuid: String(event.player.getUuid()),
    cause: cause,
  });
});
