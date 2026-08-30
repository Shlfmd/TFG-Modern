"use strict";

const LAST_MONTH_KEY = "tfgm_last_season_month";
const SUBTITLES = {
  JANUARY: "Mid-winter. Rely on reserves.",
  FEBRUARY: "Late winter. Spring is near.",
  MARCH: "Spring begins. Time to plant.",
  APRIL: "Sow seeds and nurture plants.",
  MAY: "Crops are growing strong.",
  JUNE: "Summer starts. Maintain your farm.",
  JULY: "Mid-summer heat and harvests.",
  AUGUST: "Late summer. Peak harvest time.",
  SEPTEMBER: "Prepare food storage.",
  OCTOBER: "Autumn harvest continues.",
  NOVEMBER: "Finish harvesting and prepare.",
  DECEMBER: "Winter is here. Stay warm!",
};

const SEASON_COLORS = {
  SPRING: "green",
  SUMMER: "yellow",
  FALL: "gold",
  WINTER: "aqua",
};

const FADE_IN = 10;
const STAY = 60;
const FADE_OUT = 10;
const MONTH_CHECK_INTERVAL = 20;
let ticksUntilMonthCheck = 0;

const TitlePacket = Java.loadClass(
  "net.minecraft.network.protocol.game.ClientboundSetTitleTextPacket",
);
const SubtitlePacket = Java.loadClass(
  "net.minecraft.network.protocol.game.ClientboundSetSubtitleTextPacket",
);
const TimesPacket = Java.loadClass(
  "net.minecraft.network.protocol.game.ClientboundSetTitlesAnimationPacket",
);

function capitalize(name) {
  const lower = String(name).toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function currentMonth(server) {
  const calendar = TFC.calendar.getCalendar(server.overworld);
  return TFC.calendar.getMonthOfYear(
    calendar.getCalendarTicks(),
    calendar.getCalendarDaysInMonth(),
  );
}

function sendToPlayer(player, month) {
  const connection = player.connection;
  if (!connection) {
    return;
  }
  const monthName = String(month.name());
  const seasonName = String(month.getSeason().name());
  const color = SEASON_COLORS[seasonName] || "white";
  connection.send(new TimesPacket(FADE_IN, STAY, FADE_OUT));
  connection.send(new TitlePacket(Text[color](capitalize(monthName))));
  connection.send(new SubtitlePacket(Text.gray(SUBTITLES[monthName])));
}

ServerEvents.tick((event) => {
  if (ticksUntilMonthCheck > 0) {
    ticksUntilMonthCheck--;
    return;
  }
  ticksUntilMonthCheck = MONTH_CHECK_INTERVAL - 1;
  const month = currentMonth(event.server);
  const data = event.server.persistentData;
  if (
    data.contains(LAST_MONTH_KEY) &&
    data.getInt(LAST_MONTH_KEY) === month.ordinal()
  ) {
    return;
  }
  data.putInt(LAST_MONTH_KEY, month.ordinal());
  const players = event.server.players;
  for (let i = 0; i < players.size(); i++) {
    sendToPlayer(players.get(i), month);
  }
});

PlayerEvents.loggedIn((event) => {
  event.server.scheduleInTicks(1, () => {
    if (event.player.isAlive()) {
      sendToPlayer(event.player, currentMonth(event.server));
    }
  });
});
