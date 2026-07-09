import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PAGE_URL = "https://www.fotballfesten.no/frognerstadion";
const PLACEHOLDER_TEXT = "Billetter kommer snart";

// Tekst-signal som tyder på at billettar faktisk er lagde ut.
// "book billett" og "book oppgradering" er henta frå Kongens Gate-sida
// (fotballfesten.no/home-3-1), som har billettar ute for sal.
const PURCHASE_TEXT_SIGNALS = [
  "book billett",
  "kjøp billett",
  "book oppgradering",
  "kjøp nå",
  "kjøp dine billetter",
  "bestill billett",
  "kjøp her",
  "til billetter",
];
// Lenke-signal. Fotballfesten sel billettar via sitt eige bookingsystem på
// fanparks.fanparks.com/booking/... (observert på Kongens Gate-sida). Det er
// det sterkaste signalet. Resten er vanlege billettleverandørar som fallback.
// NB: unngå generiske ord som "checkout" – Squarespace legg inn slik
// commerce-boilerplate i HTML-en uansett, og det gjev falske treff.
const PURCHASE_LINK_SIGNALS = [
  "fanparks.fanparks.com/booking",
  "fanparks.com/booking",
  "ticketco",
  "tikkio",
  "ticketmaster",
  "billetto",
  "hoopla",
];

// Sida må framleis sjå ut som rett side, elles droppar vi vurderinga.
const VALIDATION_MARKERS = ["frogner"];

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "..", "state", "detected.flag");
// Markerer at eingongs-introduksjonsmeldinga er sendt.
const INTRO_FILE = join(__dirname, "..", "state", "intro.flag");

const NIGHT_START_HOUR = 1; // 01:00 lokal tid
const NIGHT_END_HOUR = 6; // 06:00 lokal tid

/**
 * Les eit positivt heiltal frå miljøet, med fallback dersom det manglar
 * eller er ugyldig.
 */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// «watch»-modus: køyr sjekken i ein loop innanfor éi Actions-køyring, så vi
// kjem under GitHub sitt 5-minutts cron-golv utan å hamre serveren.
const WATCH_INTERVAL_SECONDS = envInt("WATCH_INTERVAL_SECONDS", 15);
// Tilfeldig ± på intervallet, så trafikken ikkje er heilt regelmessig.
const WATCH_JITTER_SECONDS = envInt("WATCH_JITTER_SECONDS", 3);
// Maks levetid for éi køyring. Cron startar ei ny etterpå. Held oss godt
// under jobb-timeouten og lèt ny kode/rekkjefølgje bli plukka opp jamt.
const WATCH_MAX_SECONDS = envInt("WATCH_MAX_SECONDS", 270);
// Ekstra pause (sekund) etter ein feil, for å vere snill mot serveren og
// unngå utestenging dersom sida byrjar å avvise oss. Doblar seg per feil.
const WATCH_ERROR_BACKOFF_SECONDS = envInt("WATCH_ERROR_BACKOFF_SECONDS", 30);
const WATCH_MAX_BACKOFF_SECONDS = envInt("WATCH_MAX_BACKOFF_SECONDS", 300);

// I CI køyrer fleire vakter i parallel. For å unngå duplikat-varsel når
// billettane dukkar opp, sender dei IKKJE sjølve: dei skriv berre flagget.
// Så committar kvar jobb flagget og prøver `git push` – berre den som vinn
// (fast-forward) sender via «notify». Dei andre får push avvist og teier.
// Lokalt (utan DEFER_NOTIFY) sender vi som før, med ein gong.
const DEFER_NOTIFY = process.env.DEFER_NOTIFY === "1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Timen (0-23) i Europe/Oslo akkurat no. Robust mot sommar-/vintertid.
 */
function osloHour() {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    hour: "2-digit",
    hour12: false,
  });
  return Number.parseInt(formatter.format(new Date()), 10);
}

/**
 * Lesbar dato+tid i Europe/Oslo, til bruk i pulsmeldinga.
 */
function osloTimestamp() {
  return new Intl.DateTimeFormat("nb-NO", {
    timeZone: "Europe/Oslo",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
}

function isNightTime() {
  const hour = osloHour();
  return hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR;
}

async function fetchPage() {
  const response = await fetch(PAGE_URL, {
    headers: {
      // Litt realistisk UA for å unngå enkel bot-blokkering.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      "Accept-Language": "nb-NO,nb;q=0.9,en;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Uventa HTTP-status ${response.status} frå ${PAGE_URL}`);
  }
  return response.text();
}

/**
 * Avgjer om billettane truleg er ute. Returnerer eit objekt med
 * avgjerd + grunn, eller null dersom sida ikkje kunne vurderast trygt.
 */
function evaluate(html) {
  const lower = html.toLowerCase();

  const looksValid = VALIDATION_MARKERS.every((marker) =>
    lower.includes(marker)
  );
  if (!looksValid) {
    return { valid: false };
  }

  const placeholderGone = !lower.includes(PLACEHOLDER_TEXT.toLowerCase());

  const purchaseTextHit = PURCHASE_TEXT_SIGNALS.find((signal) =>
    lower.includes(signal)
  );
  const purchaseLinkHit = PURCHASE_LINK_SIGNALS.find((signal) =>
    lower.includes(signal)
  );

  const reasons = [];
  if (placeholderGone) {
    reasons.push(`«${PLACEHOLDER_TEXT}» er borte frå sida`);
  }
  if (purchaseTextHit) {
    reasons.push(`fann kjøpstekst: «${purchaseTextHit}»`);
  }
  if (purchaseLinkHit) {
    reasons.push(`fann billettlenke-signal: «${purchaseLinkHit}»`);
  }

  return {
    valid: true,
    ticketsOut: reasons.length > 0,
    reasons,
  };
}

async function flagExists(file) {
  try {
    await readFile(file, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function writeFlag(file, payload) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function introMessage() {
  return [
    "✅ <b>Frogner billettvakt er i gang!</b>",
    "",
    "Eg overvakar fotballfesten.no/frognerstadion og seier ifrå her så snart billettane til Frogner truleg blir lagde ut.",
    "",
    "<b>Slik fungerer det:</b>",
    "• Eg sjekkar sida jamnleg (så ofte som mogleg på dagtid, med pause 01–06).",
    "• Så snart «Billetter kommer snart» forsvinn, eller det dukkar opp ei kjøpslenke eller kjøpsknapp, varslar eg her — éin gong.",
    "• Kvar 2. time sender eg ein liten puls så de veit at vakta lever.",
    "",
    `👉 ${PAGE_URL}`,
  ].join("\n");
}

function heartbeatMessage() {
  return [
    `💓 <b>Billettvakta lever</b> (${osloTimestamp()}).`,
    "Framleis ingen billettar oppdaga — eg varslar med ein gong noko skjer.",
  ].join("\n");
}

function ticketsMessage(reasons) {
  return [
    "🎟️ <b>Frogner-billettar!</b>",
    "",
    "Sida ser ut til å ha endra seg – billettane kan vere lagde ut:",
    reasons.join("; "),
    "",
    `👉 ${PAGE_URL}`,
  ].join("\n");
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error(
      "Manglar TELEGRAM_BOT_TOKEN og/eller TELEGRAM_CHAT_ID i miljøet."
    );
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Telegram-varsling feila: HTTP ${response.status} ${body}`.trim()
    );
  }
}

/**
 * Køyrer éin billettsjekk. Returnerer true når vakta er i ein terminal
 * tilstand (varsel sendt, allereie varsla, eller nattpause) og ein loop
 * difor bør stoppe. Returnerer false når det er verdt å prøve igjen seinare.
 */
async function runCheck() {
  if (isNightTime()) {
    console.log(
      `Nattpause (Oslo-time ${osloHour()}, mellom ${NIGHT_START_HOUR}–${NIGHT_END_HOUR}). Hoppar over.`
    );
    return true;
  }

  if (await flagExists(STATE_FILE)) {
    console.log(
      "Varsel er allereie sendt (state/detected.flag finst). Slett fila for å arme vakta på nytt."
    );
    return true;
  }

  const html = await fetchPage();
  const result = evaluate(html);

  if (!result.valid) {
    console.warn(
      "Sida såg ikkje gyldig ut (fann ikkje forventa innhald). Hoppar over for å unngå falskt varsel."
    );
    return false;
  }

  if (!result.ticketsOut) {
    console.log(`Ingen endring: «${PLACEHOLDER_TEXT}» er framleis på sida.`);
    return false;
  }

  const reasonText = result.reasons.join("; ");
  const message = ticketsMessage(result.reasons);
  const payload = {
    detectedAt: new Date().toISOString(),
    reasons: result.reasons,
    url: PAGE_URL,
    message,
  };

  if (DEFER_NOTIFY) {
    // Ikkje send her. Skriv flagget; workflowen let push-vinnaren varsle.
    await writeFlag(STATE_FILE, { ...payload, notified: false });
    console.log(`Treff registrert (deferra varsling). Grunn: ${reasonText}`);
    return true;
  }

  await sendTelegram(message);
  await writeFlag(STATE_FILE, { ...payload, notified: true });
  console.log(`Varsel sendt. Grunn: ${reasonText}`);
  return true;
}

/**
 * Køyrer billettsjekken i ein loop innanfor éi Actions-køyring, ca. kvart
 * WATCH_INTERVAL_SECONDS (med jitter). Avsluttar ved treff/terminal tilstand
 * eller når WATCH_MAX_SECONDS er brukt opp. Feil under henting stoppar ikkje
 * loopen; i staden ventar vi lenger (aukande backoff) for ikkje å bli utestengd.
 */
async function runWatch() {
  const deadline = Date.now() + WATCH_MAX_SECONDS * 1000;
  let consecutiveErrors = 0;
  let checks = 0;

  console.log(
    `Watch startar: sjekk ~kvart ${WATCH_INTERVAL_SECONDS}s (±${WATCH_JITTER_SECONDS}s) i opptil ${WATCH_MAX_SECONDS}s.`
  );

  while (Date.now() < deadline) {
    let waitSeconds;
    try {
      const stop = await runCheck();
      checks += 1;
      consecutiveErrors = 0;
      if (stop) {
        console.log(`Watch avsluttar etter ${checks} sjekk (terminal tilstand).`);
        return;
      }
      const jitter = Math.round((Math.random() * 2 - 1) * WATCH_JITTER_SECONDS);
      waitSeconds = Math.max(1, WATCH_INTERVAL_SECONDS + jitter);
    } catch (error) {
      consecutiveErrors += 1;
      waitSeconds = Math.min(
        WATCH_ERROR_BACKOFF_SECONDS * 2 ** (consecutiveErrors - 1),
        WATCH_MAX_BACKOFF_SECONDS
      );
      console.warn(
        `Sjekk feila (${consecutiveErrors} på rad): ${error.message}. Ventar ${waitSeconds}s før nytt forsøk.`
      );
    }

    if (Date.now() + waitSeconds * 1000 >= deadline) {
      break;
    }
    await sleep(waitSeconds * 1000);
  }

  console.log(`Watch ferdig (tidsbudsjett brukt opp) etter ${checks} sjekk.`);
}

/**
 * Sender ein "alt fungerer"-puls. Første gong (før state/intro.flag finst)
 * sender han i staden ei eingongs introduksjonsmelding som forklarar oppsettet.
 */
async function runHeartbeat() {
  if (!(await flagExists(INTRO_FILE))) {
    await sendTelegram(introMessage());
    await writeFlag(INTRO_FILE, { sentAt: new Date().toISOString() });
    console.log("Introduksjonsmelding sendt (éin gong).");
    return;
  }

  if (isNightTime()) {
    console.log(
      `Nattpause (Oslo-time ${osloHour()}, mellom ${NIGHT_START_HOUR}–${NIGHT_END_HOUR}). Hoppar over puls.`
    );
    return;
  }

  await sendTelegram(heartbeatMessage());
  console.log("Puls sendt.");
}

/**
 * Sender varselet som ligg lagra i state/detected.flag. Blir kalla av
 * workflowen etter at jobben har vunne git-push-kappløpet om treffet, slik
 * at berre éin av dei parallelle vaktene faktisk varslar. Idempotent: hoppar
 * over dersom flagget alt er markert som varsla.
 */
async function runNotify() {
  const raw = await readFile(STATE_FILE, "utf8").catch(() => null);
  if (raw === null) {
    console.log("Ingen state/detected.flag å varsle frå.");
    return;
  }

  const data = JSON.parse(raw);
  if (data.notified) {
    console.log("Flagget er alt markert som varsla. Hoppar over.");
    return;
  }

  await sendTelegram(data.message ?? ticketsMessage(data.reasons ?? []));
  await writeFlag(STATE_FILE, { ...data, notified: true });
  console.log("Varsel sendt (notify).");
}

async function main() {
  const mode = process.argv[2] ?? "check";
  switch (mode) {
    case "check":
      await runCheck();
      return;
    case "watch":
      await runWatch();
      return;
    case "heartbeat":
      await runHeartbeat();
      return;
    case "notify":
      await runNotify();
      return;
    default:
      throw new Error(
        `Ukjend modus: «${mode}». Bruk «check» (standard), «watch», «heartbeat» eller «notify».`
      );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
