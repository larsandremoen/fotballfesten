# Frogner billettvakt

Overvakar [fotballfesten.no/frognerstadion](https://www.fotballfesten.no/frognerstadion) og sender ei **Telegram-melding** når billettane truleg er lagde ut for sal.

Køyrer på GitHub Actions så tett på sanntid som mogleg (sjå merknad under), med nattpause mellom 01 og 06 (lokal tid, Oslo).

## Korleis det oppdagar billettar

Scriptet ([`src/check.js`](src/check.js)) hentar sida og reknar det som "billettar ute" dersom:

- **Primærsignal:** teksten `Billetter kommer snart` er borte, ELLER
- **Støttesignal:** ein kjøpsindikator dukkar opp — kjøpstekst (`Book billetter`, `Kjøp billetter`, `Book oppgradering`, …) eller ei billettlenke. Det sterkaste lenkesignalet er Fotballfesten sitt eige bookingsystem `fanparks.fanparks.com/booking/…` (observert på [Kongens Gate-sida](https://www.fotballfesten.no/home-3-1) som har billettar ute), med vanlege leverandørar (`ticketco`, `tikkio`, `ticketmaster`, …) som fallback.

For å unngå falske varsel blir sida først validert (HTTP 200 + inneheld framleis "Frogner"). Etter første treff blir `state/detected.flag` committa til repoet, slik at du ikkje får spam. Slett den fila for å arme vakta på nytt.

Sidan fleire vakter køyrer i parallel (sjå under) sender dei ikkje varselet sjølve i CI: kvar jobb som ser treffet skriv flagget og prøver `git push`. Berre jobben som vinn (fast-forward er atomisk) sender Telegram-meldinga via `node src/check.js notify`; dei andre får push avvist og teier. Slik får du **eitt** varsel sjølv om mange vakter oppdagar det same treffet samtidig.

## Puls og introduksjonsmelding

For at du skal vere trygg på at vakta faktisk lever, sender ein eigen workflow ([`.github/workflows/heartbeat.yml`](.github/workflows/heartbeat.yml)) ein **puls kvar 2. time** til den same Telegram-chaten (`node src/check.js heartbeat`). Pulsen respekterer same nattpause 01–06 (Oslo).

Aller første gong puls-jobben køyrer sender han i staden éi **introduksjonsmelding** som forklarar kva vakta gjer og korleis. Den blir sendt berre éin gong, markert med `state/intro.flag` i repoet. Slett den fila om du vil sende introduksjonen på nytt.

## Oppsett

### 1. Lag ein Telegram-bot

1. Opne Telegram og start ein chat med [@BotFather](https://t.me/BotFather).
2. Send `/newbot` og følg instruksjonane. Du får eit **bot-token** (ser ut som `123456789:ABC-DEF...`).
3. Start ein chat med din nye bot og send ei melding (t.d. `hei`) — botten må ha fått minst éi melding frå deg.

### 2. Finn chat-id-en din

1. Opne `https://api.telegram.org/bot<DITT_TOKEN>/getUpdates` i nettlesaren (byt ut `<DITT_TOKEN>`).
2. Finn `"chat":{"id":...}` i svaret. Dette talet er `TELEGRAM_CHAT_ID`.

### 3. Legg inn secrets i GitHub

Gå til repoet på GitHub → **Settings → Secrets and variables → Actions → New repository secret** og legg til:

| Namn                 | Verdi                       |
| -------------------- | --------------------------- |
| `TELEGRAM_BOT_TOKEN` | bot-tokenet frå BotFather   |
| `TELEGRAM_CHAT_ID`   | chat-id-en frå steg 2       |

### 4. Slå på og test

- Workflowen ([`.github/workflows/check-tickets.yml`](.github/workflows/check-tickets.yml)) startar automatisk på schedule når han ligg på standardbranchen.
- Test heile kjeda manuelt: gå til **Actions → Frogner billettvakt → Run workflow** (`workflow_dispatch`).

## Køyre lokalt

Krev Node 20+.

```bash
export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_CHAT_ID="..."
npm run check                 # éin billettsjekk
node src/check.js watch       # loop: sjekk ~kvart 15. s til treff/timeout
node src/check.js heartbeat   # puls / første gong: introduksjonsmelding
node src/check.js notify      # send varselet lagra i state/detected.flag (brukt av CI)
```

> **Tips for grupper:** chat-id-en til ei (super)gruppe er eit **negativt** tal (t.d. `-1001234567890`). Ta med minusteiknet i secreten. Boten må vere medlem, og for at gruppa skal dukke opp i `getUpdates` må boten anten vere admin eller ha «privacy mode» slått av (via BotFather → `/setprivacy`).

## Godt å vite

- **Tett sjekk via watch-loop:** GitHub sin cron kan berre starte kvart 5. minutt, så for å komme tettare køyrer billettvakta i `watch`-modus: kvar vakt loopar internt og sjekkar ~kvart 15. sekund (med litt tilfeldig jitter) i knappe 5 minutt. Dette krev at repoet er **offentleg** (gratis, uendelege Actions-minutt); på private repo tel kvart minutt mot kvota.
- **Parallelle, forskuva vakter:** kvar cron-tick startar fleire vakter samtidig (matrise med forskuv `0/75/150/225` sekund), så éin tick dekkjer heile 5-minutters-vindauget tett. Vindauga overlappar dessutan med neste tick, så ei forseinka cron-køyring ikkje etterlèt hol. Fleire vakter gir òg redundans: sjølv om éi vakt hamnar i backoff etter feil, held dei andre fram. Juster tettleiken ved å endre `offset`-lista i workflowen.
- **Eitt varsel trass parallellitet:** dedupen går via git (sjå over) – push er atomisk, så berre éin jobb varslar sjølv om alle dei parallelle vaktene ser treffet i same sekund.
- **Snill mot serveren:** intervallet har jitter, og ved feil (t.d. om sida byrjar avvise oss) aukar ventetida gradvis (backoff) for å unngå utestenging. Så snart eit treff er registrert, stoppar loopen. Justerbart via miljøvariablar: `WATCH_INTERVAL_SECONDS`, `WATCH_JITTER_SECONDS`, `WATCH_MAX_SECONDS`, `WATCH_ERROR_BACKOFF_SECONDS`, `WATCH_MAX_BACKOFF_SECONDS`. Fleire parallelle vakter tyder fleire kall til sida per sekund – aukar du `offset`-lista mykje, vurder å auke `WATCH_INTERVAL_SECONDS` tilsvarande.
- **GitHub garanterer ikkje eksakt intervall;** planlagte jobbar kan forseinkast (ofte 5–15 min ved høg last). Overlappande vindauge + forskuva vakter dempar dette.
- Cron i workflowen er i **UTC** (`*/5 4-22 * * *`). Scriptet har i tillegg ein `Europe/Oslo`-sjekk, så nattpausen 01–06 held seg rett også ved skifte mellom sommar- og vintertid.
