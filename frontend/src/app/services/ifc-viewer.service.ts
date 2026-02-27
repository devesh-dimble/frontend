import { Injectable, signal, OnDestroy, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class IfcViewerService implements OnDestroy {
  private platformId = inject(PLATFORM_ID);
  private sanitizer = inject(DomSanitizer);

  /** The iframe element reference – set by the component after view init */
  private iframeEl: HTMLIFrameElement | null = null;

  /** Trusted iframe URL for binding in the template */
  readonly viewerUrl: SafeResourceUrl;

  /** GlobalId of the currently selected IFC element (from the viewer) */
  readonly selectedIfcGlobalId = signal<string | null>(null);

  /** Express-ID of the currently selected IFC element (from the viewer) */
  readonly selectedIfcExpressId = signal<number | null>(null);

  /** IFC property sets for the selected element (from IFC_PROPERTIES message) */
  readonly ifcProperties = signal<Record<string, unknown> | null>(null);

  /** GlobalIds currently highlighted via topic link (empty when none). */
  readonly linkedHighlightGlobalIds = signal<string[]>([]);

  private screenshotResolver: ((base64: string | null) => void) | null = null;
  private messageHandler = this.onMessage.bind(this);

  constructor() {
    const baseUrl = (environment as Record<string, unknown>)['ifcViewerUrl'] as string ?? 'http://localhost:5173';
    this.viewerUrl = this.sanitizer.bypassSecurityTrustResourceUrl(baseUrl);

    if (isPlatformBrowser(this.platformId)) {
      window.addEventListener('message', this.messageHandler);
    }
  }

  ngOnDestroy(): void {
    if (isPlatformBrowser(this.platformId)) {
      window.removeEventListener('message', this.messageHandler);
    }
  }

  /** Store the iframe element so we can postMessage into it */
  setIframe(el: HTMLIFrameElement): void {
    this.iframeEl = el;
  }

  /** Tell the IFC viewer to load a model from the given URL */
  loadModel(url: string): void {
    this.postToViewer({ type: 'LOAD_IFC', url });
  }

  /** Clear the current element selection and tell the viewer to deselect */
  clearSelection(): void {
    this.selectedIfcGlobalId.set(null);
    this.selectedIfcExpressId.set(null);
    this.ifcProperties.set(null);
    this.postToViewer({ type: 'DESELECT' });
  }

  /** Highlight linked IFC objects in the viewer by GlobalIds (e.g. from BCF topic). Color as hex number. */
  highlightLinked(globalIds: string[], color?: number): void {
    this.linkedHighlightGlobalIds.set(globalIds?.length ? [...globalIds] : []);
    this.postToViewer({ type: 'HIGHLIGHT_LINKED', globalIds: globalIds ?? [], color });
  }

  /** Clear the linked highlight and restore original colors. */
  clearLinkedHighlight(): void {
    this.linkedHighlightGlobalIds.set([]);
    this.postToViewer({ type: 'CLEAR_LINKED_HIGHLIGHT' });
  }

  /** Request a screenshot from the viewer iframe. Resolves with raw base64 (no prefix) or null on failure. */
  requestScreenshot(): Promise<string | null> {
    return new Promise(resolve => {
      this.screenshotResolver = resolve;
      this.postToViewer({ type: 'CAPTURE_SCREENSHOT' });
      setTimeout(() => {
        if (this.screenshotResolver === resolve) {
          this.screenshotResolver = null;
          resolve(null);
        }
      }, 5000);
    });
  }

  // ───────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────

  private postToViewer(data: unknown): void {
    const win = this.iframeEl?.contentWindow;
    if (!win) {
      console.warn('[IfcViewerService] iframe not ready – message dropped', data);
      return;
    }
    win.postMessage(data, '*');
  }

  private onMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'IFC_SELECTION':
        this.selectedIfcGlobalId.set(msg.globalId ?? null);
        this.selectedIfcExpressId.set(msg.expressId ?? null);
        this.ifcProperties.set(null);
        break;
      case 'IFC_PROPERTIES':
        this.ifcProperties.set(msg.data ?? null);
        break;
      case 'IFC_SCREENSHOT':
        if (this.screenshotResolver) {
          this.screenshotResolver(msg.base64 ?? null);
          this.screenshotResolver = null;
        }
        break;
    }
  }
}
