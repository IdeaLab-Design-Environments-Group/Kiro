/**
 * Composition root. Wires the Kirigamizer shell together in classic MVC:
 *
 *   Model       src/model/   — AppStore (observable UI state) + derive-facts presenter;
 *                              the simulation domain model lives under src/sim/.
 *   View        src/view/    — ConvertPanel · MetadataPanel · ViewerFrame · HeaderActions ·
 *                              SimModal. Dumb: render state, emit user intents.
 *   Controller  src/controller/ — AppController: file IO/parsing, the kirigamize/sample
 *                              actions, and the store↔view subscription.
 *
 * This file owns no behavior beyond construction and mounting.
 */
import "./styles.css";
import { AppStore } from "./model/app-store.js";
import { ConvertPanel } from "./view/convert-panel.js";
import { MetadataPanel } from "./view/metadata-panel.js";
import { ViewerFrame } from "./view/viewer-frame.js";
import { HeaderActions } from "./view/header-actions.js";
import { SimModal } from "./view/sim-modal.js";
import { AppController } from "./controller/app-controller.js";

const app = document.getElementById("app");
if (!app) throw new Error("Missing #app root");

// ---- Model ----------------------------------------------------------------
const store = new AppStore();

// ---- Views (three columns + header actions + sim modal) -------------------
const convert = new ConvertPanel();
const metadata = new MetadataPanel();
const viewer = new ViewerFrame();
app.append(convert.element, metadata.element, viewer.element);

const simModal = new SimModal();
const header = new HeaderActions();
simModal.mountTrigger(header.element); // 3D Sim trigger first…
header.appendActionButtons(); // …then Load sample + Kirigamize ▶
document.querySelector(".app-header")?.appendChild(header.element);

// ---- Controller -----------------------------------------------------------
const controller = new AppController(store, convert, metadata, viewer, header, simModal);

// Default state: load the bundled FKLD example so the panels, viewer, and 3D
// Sim are all live on first paint (no-op under file:// where fetch is blocked).
void controller.loadSample(false);
