# Meerwaardebelasting – browserversie

De versie die op je claude.ai-link draait. Alles werkt in de browser; er is geen server nodig.

> **Disclaimer:** rekenhulp, geen fiscaal advies. Controleer met de FOD Financiën of een adviseur.

## Bestanden

| Bestand | Inhoud |
|---|---|
| `index.html` | De volledige pagina (gebouwd, alles ingesloten). Open lokaal in een browser of publiceer. |
| `template.html` | HTML en CSS met plaatshouders voor de scripts |
| `engine.js` | Rekenkern (exacte decimalen met BigInt): FIFO, fotowaarde 31/12/2025, historische prijs t.e.m. 2030, vrijstelling en overdracht, delisting |
| `app.js` | Interface, validatie, opslag (Claude-account in delen of browser), back-up, import |
| `bolero.js` | Importer voor de Bolero-export "Cashbewegingen" (Excel of CSV) |
| `saxo.js` | Importer voor de Saxo-export "Transacties" (standaard, Excel) en de oudere export "Trades" (Excel of CSV) |
| `xlsx.js` | Minimale Excel-lezer zonder externe bibliotheek |
| `geld.js` | Geldbewegingen (stortingen, opnames, kapitaalverminderingen, ...): soorten, dubbels, geldoverzicht per jaar |
| `bewijs.js` | Bewijsstukken bij transacties: toegelaten bestandstypes, welke transacties nog een bewijs missen |
| `simulatie.js` | Simulatie: impact van een fictieve verkoop (rekent met en zonder via de rekenkern, vergelijkt per jaar; bewaart niets) |
| `sync.js` | Synchroniseren tussen toestellen in de app op GitHub Pages: koppelcode, versleuteling (AES-256-GCM), drie-weg samenvoegen |
| `qrcode.js` | QR-codegenerator (Kazuhiko Arase, MIT-licentie), enkel geladen om de koppelcode als QR-code te tonen |
| `jsQR.js` | QR-lezer (jsQR, Apache-2.0-licentie, zie `LICENSE-jsQR`), enkel geladen bij *QR-code scannen* als de browser geen `BarcodeDetector` heeft |
| `pdf.js` | Rapport als PDF (minimale PDF-generator zonder externe bibliotheek, Helvetica met WinAnsi-tekens) |
| `build.py` | Voegt alles samen tot `index.html` |
| `manifest.webmanifest`, `sw.js`, `icon*` | Installeerbare app (PWA) op GitHub Pages; niet gebruikt op claude.ai |
| `*.test.js` | Tests (Node 18+) |

## Bouwen en testen

```bash
python3 build.py                 # maakt index.html
node --test engine.test.js       # rekenkern
node --test bolero.test.js       # Bolero-importer (synthetisch bestand)
node --test saxo.test.js         # Saxo-importer (synthetisch bestand)
node --test bewijs.test.js       # bewijsstukken
node --test pdf.test.js          # PDF-generator
node --test geld.test.js         # geldbewegingen en geldoverzicht
node --test simulatie.test.js    # simulatie van een verkoop
node --test sync.test.js         # synchroniseren: code, versleuteling, samenvoegen

# optioneel tegen je eigen exports:
BOLERO_FILE=pad/naar/cashmovements.xlsx node --test bolero.test.js   # of .csv
SAXO_FILE=pad/naar/Transactions.xlsx node --test saxo.test.js
```

Lokaal openen: `python3 -m http.server` in deze map en ga naar http://localhost:8000. Buiten claude.ai bewaart de
pagina gegevens alleen in je browser (localStorage); maak een back-up via Instellingen.

## Installeren als app (GitHub Pages)

Op https://glorfunk850.github.io/Meerwaardebelasting/ is de tool als app te installeren (Chrome/Edge: 'App installeren'
in de adresbalk of via Instellingen → *Als app installeren*; iPhone/iPad: Safari → Deel → *Zet op beginscherm*).
De service worker (`sw.js`) haalt altijd eerst de nieuwste versie op en valt zonder verbinding terug op de laatst
bewaarde kopie. Verhoog `CACHE` in `sw.js` als je de lijst met bestanden wijzigt.

Gegevens staan in die versie in de browser (localStorage), los van de claude.ai-pagina. Overzetten naar claude.ai gaat via
Instellingen → Back-up downloaden en Back-up herstellen. Op claude.ai en bij een lokaal geopend bestand doet de
installatiecode niets.

## Synchroniseren tussen toestellen (app op GitHub Pages)

Instellingen → *Synchroniseren tussen toestellen* houdt transacties, geldbewegingen, activa, ingehouden bedragen,
fiscale parameters en instellingen gelijk op al je toestellen. Het werkt zoals de synchronisatie van DuckDuckGo en
gebruikt dezelfde server als Voorraadbeheer (de eigen Cloudflare Worker uit de map `sync-server` van die repository;
adres in `SYNC_SERVER` in `app.js`):

- Je koppelt toestellen met een geheime code van 32 tekens (ook als QR-code). Er is geen account of wachtwoord.
- Uit die code worden op het toestel afgeleid (HKDF): het nummer van de ruimte op de server, een schrijftoken en de
  sleutel waarmee alles versleuteld wordt (AES-256-GCM). De code gaat nooit naar de server; die bewaart alleen het
  versleutelde pakket. Een eigen salt zorgt dat deze tool nooit dezelfde ruimte gebruikt als Voorraadbeheer.
- Samenvoegen is drie-weg (`sync.js`): per transactie, geldbeweging, actief en jaar, en binnen een item per veld. Alleen
  als hetzelfde veld op twee toestellen anders gewijzigd werd, wint het toestel dat synchroniseert. Een transactie die
  op het ene toestel gewist en op het andere gewijzigd werd, blijft bestaan. De volgorde van de transacties is op alle
  toestellen dezelfde (ze telt bij transacties op dezelfde dag).
- Met synchronisatie krijgen nieuwe transacties een id op basis van de tijd, zodat twee toestellen nooit hetzelfde id
  gebruiken. Bij koppelen kies je: de gegevens van het andere toestel overnemen, of samenvoegen (dan krijgen de eigen
  transacties eerst nieuwe id's; wat op beide toestellen al stond, komt er dan dubbel in).
- *Alle gegevens wissen* en *Back-up herstellen* gelden ook voor de gekoppelde toestellen.
- Bewijsstukken worden niet gesynchroniseerd; zet ze over met *Back-up met bewijsstukken*.
- Op claude.ai is dit paneel verborgen: daar synchroniseert het Claude-account al.
- Koppelen kan met *QR-code scannen* in de app zelf (camera; `BarcodeDetector` of anders `jsQR.js`) of door de code te
  typen. Scan niet met de gewone camera-app: die opent de link in de standaardbrowser, en op iPhone/iPad heeft de app op
  het beginscherm een eigen opslag, los van Safari. Gebeurt dat toch, dan waarschuwt de pagina in Safari.

## Bewijsstukken

Bij elke transactie kun je bestanden toevoegen (PDF, JPG, PNG, WEBP, GIF, TXT, CSV; max. 20 MB per bestand), bv. het
borderel of de afrekening van de bank. Op claude.ai staan ze bij de pagina in je Claude-account (capability `assets`,
even privé als de pagina); elders in de browser (IndexedDB). De transactie bewaart enkel naam, type, grootte en
verwijzing. De gewone back-up bevat dus enkel die gegevens; *Back-up met bewijsstukken* (Instellingen) zet ook de
bestanden zelf erin (base64 in het veld `proof_files`, ca. een derde groter dan de bestanden samen). Bij herstellen worden
die bestanden opnieuw opgeslagen op de plaats waar je herstelt (en niet dubbel als ze er al staan); `proof_files` komt
nooit in de bewaarde toestand. Zo verhuis je bewijsstukken ook tussen claude.ai en de app-versie. Zonder zo'n back-up zijn
bestanden van de ene plaats op de andere niet te openen.

De filter *Bewijs ontbreekt* toont verwervingen van activa die nog in bezit zijn en verkopen die belastbaar zijn
(vanaf 2026) of van activa die nog in bezit zijn, zonder bewijsstuk.

## Simulatie

Op het tabblad *Simulatie* kies je een positie, een datum, het aantal en een verkoopprijs. De tool rekent al je transacties
twee keer door met dezelfde rekenkern, zonder en met die verkoop, en toont: de meer- of minderwaarde van de verkoop per lot
(FIFO, met de gebruikte basis), het verschil in belasting, hoeveel meerwaarde er dat jaar nog belastingvrij bij kan (voor en na),
en de gevolgen voor latere jaren (minder overdraagbare vrijstelling). Er wordt niets bewaard; met *Als transactie toevoegen*
open je het gewone transactievenster met de gegevens al ingevuld. Ligt de datum vóór bestaande verkopen van hetzelfde actief,
dan verschuift FIFO bij die latere verkopen; dat zit mee in het verschil. Kosten en taksen tellen niet mee (niet aftrekbaar).

## Eigen keuzes en interpretaties

- Delisting: enkel een uitkoop/bod tegen prijs is een overdracht (verkoop); een loutere schrapping of waardeloos worden
  zonder overdracht is geen belastbaar moment. Niet uitdrukkelijk in de wet geregeld.
- Historische prijs bij meerdere aankopen vóór 2026: FIFO per lot of gemiddelde (instelbaar; het rapport toont het verschil).
- Omruiling (fusie/overname), transactietype *Omruiling*: oud effect, aantal oude stuks (leeg = volledige positie), per
  nieuw effect het aantal per oud stuk en de waarde per stuk op de ruildatum, en eventueel cash per oud stuk.
  - De omgeruilde loten (FIFO) worden nieuwe loten met **dezelfde aankoopdatum**; de aankoopprijs (en, vanaf 2026, de
    waarde op 31/12/2025) wordt verdeeld volgens de waarde op de ruildatum: aantal × waarde per nieuw effect, plus de cash.
    Bij één nieuw effect zonder cash gaat alles over en is de waarde niet nodig. Bewijsbaarheid gaat mee over.
  - Vóór 2026: geen belastbaar moment; voor de nieuwe effecten geldt hun eigen waarde op 31/12/2025 (vul die in bij
    Activa). Zonder waarden op de ruildatum wordt de aankoopprijs niet verdeeld: dan geen hogere historische prijs
    (met melding).
  - Vanaf 2026: ruildeel geen belastbaar moment; de cash (opleg) telt als verkoop van het deel van de loten dat de cash
    vertegenwoordigt. Waarden op de ruildatum zijn dan verplicht (behalve bij één nieuw effect zonder cash).
  - **Open punt:** de wet van 6.4.2026 en circulaire 2026/C/74 regelen (voor zover nagegaan, nov. 2026) niet uitdrukkelijk
    hoe de historische aankoopprijs verdeeld wordt over effecten uit een omruiling vóór 2026, noch of een ruil vanaf 2026
    fiscaal neutraal is. De verdeling volgens de waarde op de ruildatum en de neutraliteit van het ruildeel zijn een eigen
    interpretatie, te bevestigen bij de FOD Financiën of een adviseur.
  - Fracties die in cash uitbetaald werden: registreer een verkoop van het nieuwe effect op dezelfde datum. Staan de
    nieuwe effecten ook als aankoop in de export van je broker, verwijder die aankoop (anders tellen ze dubbel).
  - Een aankoop van een omgeruild effect telt voor *Bewijs ontbreekt* als 'in bezit' zolang de nieuwe effecten in bezit zijn.
  - Per nieuw effect kan ook het **totaal ontvangen aantal** ingevuld zijn (zo bewaart de import het): dat wordt evenredig over
    de omgeruilde loten verdeeld, het laatste lot krijgt de rest, zodat het totaal exact klopt.
- Bolero-import, omruiling herkennen (voorstel, de gebruiker bevestigt): de export legt geen verband tussen het oude en de nieuwe
  effecten (bij een overname staat bv. enkel een "Inboeking corporate action" van één nieuw effect en de cash als
  "Uitbetaling dividenden"). De importer zoekt daarom per positie die volgens de export nog open staat maar na een datum niet meer
  voorkomt:
  - "Inboeking corporate action"-regels binnen 7 dagen van die datum (aantal en koers; de munt van de koers staat er niet bij);
  - effecten die verkocht worden zonder aankoop in de export, met hun eerste regel tot een half jaar later (ontvangen aantal =
    grootste tekort); elk zo'n effect hoort bij het oude effect met de laatste datum ervoor;
  - de cash: een betaling binnen 7 dagen voor exact het aantal stuks in bezit. Standaard aangevinkt als ze per stuk minstens
    5 keer zo hoog is als de mediaan van de vorige dividenden (of als er geen vorige zijn).
  In het importvenster staat het voorstel onder de positietabel: nieuwe effecten aan/uit, zelf een effect toevoegen, waarde per
  stuk op de ruildatum, cash aan/uit, met het gevolg voor de loten. Bevestigd: een transactie *Omruiling* (met het totaal
  ontvangen aantal per nieuw effect), de betaling wordt geen dividend maar een geldbeweging *verwerkt*, de inboekingsregel
  ook, en het oude effect wordt niet als 'niet meer in bezit' gecorrigeerd. Een nieuwe import van dezelfde export toont het
  voorstel niet opnieuw en voegt de betaling niet alsnog als dividend toe. Zonder nieuw effect geen voorstel: de positie blijft
  gemarkeerd zoals voordien. Saxo: nog niet (geen voorbeeld van een fusie in een Saxo-export).
- Valutawinst op cash in vreemde munt wordt niet berekend.
- Bolero: wisselkoers staat niet in de export; afgeleid uit wisseltransacties of geschat uit het nettobedrag (gemarkeerd).
- Bolero: de Excel-export wordt omgezet naar dezelfde regels als de CSV-export. Transacties die al geïmporteerd zijn
  (ook via het andere formaat) worden herkend op import-id of op inhoud (type, datum, effect, aantal, prijs, bedrag).
- Saxo, standaardexport "Transacties": aantal en prijs komen uit het blad `_Transacties`, bedrag, koers en kosten uit
  `Transacties` (gekoppeld op transactie-id), de opsplitsing van de kosten uit `Bookings`. Corporate actions:
  - overnamebod/uitkoop: verkoop op de datum van het bod (een latere herboeking met hetzelfde transactie-id telt niet);
  - (omgekeerde) splitsing: splitsing met de gangbare verhouding (bv. 1 nieuw voor 10 oud) plus verkoop van de fractie
    tegen het cashbedrag uit `Bookings`;
  - stockdividend (herbeleggingsdividend): aankoop tegen de prijs van Saxo, zonder kosten;
  - kapitaalvermindering ("Waardevermindering"): niet als transactie geïmporteerd (wel als geldbeweging), met
    waarschuwing. **Open punt:** of zo'n terugbetaling de aanschaf- of fotowaarde verlaagt, regelt de wet niet uitdrukkelijk.
  - dividenden: netto per corporate action (terugboekingen afgetrokken).
- Ingehouden meerwaardebelasting: Bolero (kolom bij elke verkoop) en Saxo (boekingen "Meerwaardebelasting" in `Bookings`)
  worden per jaar en per broker opgeteld bij *Ingehouden door broker*. Een zelf ingevuld bedrag blijft staan; een export
  verhoogt het bedrag van een broker enkel (een export die maar een deel van het jaar dekt, verlaagt het niet).

## Geldbewegingen

Regels uit een export die geen effect hebben op de belasting (stortingen, opnames, wisseltransacties, kapitaalverminderingen,
teruggeboekte dividenden, storno's, ...) worden bij de import mee ingelezen als *geldbeweging* (uit te zetten in het
importvenster). Ze worden apart bewaard (`cash` in de toestand en de back-up) en gaan nooit naar de rekenkern.
Regels die al op een andere manier verwerkt zijn (ingehouden meerwaardebelasting, cash uit een overnamebod of voor een
fractie, dubbele regels bij corporate actions, geannuleerde boekingen) krijgen de status *verwerkt* met een verwijzing.
Een nieuwe import van dezelfde export voegt ze niet dubbel toe (import-id).

Op het tabblad Transacties kies je *Transacties*, *Geldbewegingen* of *Alles*, en filter je per soort. Bij geldbewegingen
staat een geldoverzicht per jaar: gestort, opgenomen, netto inbreng, dividend (netto, min terugboekingen),
kapitaalverminderingen en ingehouden meerwaardebelasting. Het rapport toont hetzelfde per eigenaar en jaar als
informatieve kaart. Enkel bedragen in EUR tellen mee in het overzicht. Het PDF-rapport bevat geen geldbewegingen.

## Rapport als PDF

Op het tabblad Rapport maakt *PDF-rapport* een A4-document met het overzicht per jaar (zoals de kaarten), elke verkoop
met de loten (aankoopdatum, aantal, opbrengst, basis en waarop die steunt, resultaat, opmerking), de gebruikte waarde op
31/12/2025 en de bron, waarschuwingen, de vergelijking met Bolero, gebeurtenissen zonder belastbaar moment, de fiscale
parameters en de ingehouden bedragen. Het bestand wordt in de browser gemaakt (`pdf.js`), zonder externe dienst.
