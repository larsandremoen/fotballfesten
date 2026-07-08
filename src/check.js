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

async function runCheck() {
  if (isNightTime()) {
    console.log(
      `Nattpause (Oslo-time ${osloHour()}, mellom ${NIGHT_START_HOUR}–${NIGHT_END_HOUR}). Hoppar over.`
    );
    return;
  }

  if (await flagExists(STATE_FILE)) {
    console.log(
      "Varsel er allereie sendt (state/detected.flag finst). Slett fila for å arme vakta på nytt."
    );
    return;
  }

  const html = await fetchPage();
  const result = evaluate(html);

  if (!result.valid) {
    console.warn(
      "Sida såg ikkje gyldig ut (fann ikkje forventa innhald). Hoppar over for å unngå falskt varsel."
    );
    return;
  }

  if (!result.ticketsOut) {
    console.log(`Ingen endring: «${PLACEHOLDER_TEXT}» er framleis på sida.`);
    return;
  }

  const reasonText = result.reasons.join("; ");
  const message = [
    "🎟️ <b>Frogner-billettar!</b>",
    "",
    "Sida ser ut til å ha endra seg – billettane kan vere lagde ut:",
    reasonText,
    "",
    `👉 ${PAGE_URL}`,
  ].join("\n");

  await sendTelegram(message);
  await writeFlag(STATE_FILE, {
    detectedAt: new Date().toISOString(),
    reasons: result.reasons,
    url: PAGE_URL,
  });
  console.log(`Varsel sendt. Grunn: ${reasonText}`);
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

async function main() {
  const mode = process.argv[2] ?? "check";
  switch (mode) {
    case "check":
      await runCheck();
      return;
    case "heartbeat":
      await runHeartbeat();
      return;
    default:
      throw new Error(
        `Ukjend modus: «${mode}». Bruk «check» (standard) eller «heartbeat».`
      );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
