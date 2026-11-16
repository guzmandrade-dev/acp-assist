'use strict';

// PDF-review mode wiring: "Open in viewer" opens the active PDF in the
// user's own PDF viewer (SumatraPDF when detected, with page jumps;
// otherwise the OS default). When no PDF is active yet, the same button
// picks a PDF from the filesystem (native dialog in Electron) and opens
// THAT file — at its real path, not an uploaded copy — as the active
// document, so file names and history stay natural. Attaching a PDF via
// + does the same via the file's real path when available (attachments.js).

import { CONFIG, state, openViewerBtn, fileInput } from './state.js';
import { api } from './api.js';
import { addSystemMessage } from './messages.js';
import { refreshDocuments } from './documents.js';

if (CONFIG.pdfMode && openViewerBtn) {
  openViewerBtn.addEventListener('click', async () => {
    if (!state.sessionId || state.busy) return;
    try {
      if (!state.activeDocPath) {
        // No PDF open yet: pick one from disk — it becomes the active PDF
        // AND opens in the viewer in a single step.
        if (window.electron?.pickPdf) {
          const picked = await window.electron.pickPdf();
          if (!picked) return;
          await api(`/api/session/${state.sessionId}/pdf/open`, {
            method: 'POST',
            body: JSON.stringify({ path: picked }),
          });
          await refreshDocuments();
        } else {
          // Standalone host (no Electron): fall back to the upload flow,
          // which auto-opens an attached PDF (see attachments.js).
          fileInput.value = '';
          fileInput.click();
          return;
        }
      }
      const r = await api(`/api/session/${state.sessionId}/open-external`, {
        method: 'POST',
        body: '{}',
      });
      addSystemMessage(`Opened ${r.path} in ${r.viewer ?? 'the system viewer'}`);
    } catch (e) {
      addSystemMessage(`could not open the viewer: ${e.message}`, true);
    }
  });
}
