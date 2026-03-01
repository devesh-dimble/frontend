import { Component, OnDestroy, OnInit, AfterViewInit, ViewChild, ElementRef, computed, PLATFORM_ID, inject, signal, HostListener } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { isPlatformBrowser } from '@angular/common';
import { BcfService, BcfTopic } from './services/bcf.service';
import { AuthService } from './services/auth.service';
import { BcfApiService, BcfApiTopic, BcfProject, extractIfcGuidsFromViewpoints, mergeSelectionWithViewpoints } from './services/bcf-api.service';
import { IfcViewerService } from './services/ifc-viewer.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy, AfterViewInit {
  
  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.enlargedSnapshotUrl()) {
      this.closeSnapshotLightbox();
      return;
    }
    this.clearAllSelections();
  }

  @ViewChild('ifcViewerFrame') ifcViewerFrame!: ElementRef<HTMLIFrameElement>;

  private platformId = inject(PLATFORM_ID);
  protected bcfService = inject(BcfService);
  protected authService = inject(AuthService);
  protected bcfApiService = inject(BcfApiService);
  protected ifcViewerService = inject(IfcViewerService);

  protected isDraggingBcf = false;
  
  // UI State
  protected showLoginModal = signal(false);
  protected showCreateTopicModal = signal(false);
  protected showProjectSelector = signal(false);
  protected useServerBcf = signal(false);
  
  // Login form
  protected loginUsername = '';
  protected loginPassword = '';
  
  // Create topic form
  protected newTopicTitle = '';
  protected newTopicDescription = '';
  protected newTopicPriority = 'Normal';
  
  // Comment form  
  protected newComment = '';
  protected expandedTopicGuid = signal<string | null>(null);

  /** Link highlight color (hex number). Default green. */
  protected linkHighlightColor = signal<number>(0xbcf124);
  /** Color picker value as #rrggbb for input[type=color]. */
  protected linkHighlightColorHex = signal<string>('#bcf124');
  /** Short-lived message after link action: "Select an IFC object...", "Linked", or error. */
  protected linkFeedbackMessage = signal<string | null>(null);

  /** Short-lived message after snapshot capture. */
  protected snapshotFeedbackMessage = signal<string | null>(null);
  /** Cached Object URLs keyed by viewpointGuid, nested by topicGuid. */
  private topicSnapshotCache = new Map<string, Map<string, string>>();
  /** Signal that triggers re-reads of snapshot URLs in the template. */
  protected topicSnapshotVersion = signal(0);
  /** URL of snapshot currently shown in lightbox, or null if closed. */
  protected enlargedSnapshotUrl = signal<string | null>(null);

  // IFC Viewer
  protected ifcViewerUrl = this.ifcViewerService.viewerUrl;
  protected linkedHighlightGlobalIds = this.ifcViewerService.linkedHighlightGlobalIds;

  // File-based BCF (filtered by selected IFC object when one is selected and topics have relatedElements)
  protected isLoadingFileBcf = computed(() => this.bcfService.isLoading());
  protected fileBcfTopics = computed(() => {
    const topics = this.bcfService.topics();
    const selectedId = this.ifcViewerService.selectedIfcGlobalId();
    if (!selectedId) return topics;
    const hasAnyRelated = topics.some(t => (t.relatedElements?.length ?? 0) > 0);
    if (!hasAnyRelated) return topics;
    return topics.filter(t => t.relatedElements?.includes(selectedId) ?? false);
  });
  protected selectedFileTopic = computed(() => this.bcfService.selectedTopic());

  // Auth
  protected isAuthenticated = computed(() => this.authService.isAuthenticated());
  protected isLoggingIn = computed(() => this.authService.isLoggingIn());
  protected loginError = computed(() => this.authService.loginError());
  protected currentUser = computed(() => this.authService.user());
  
  // Server BCF (topic list filtered by selected IFC object when one is selected)
  protected projects = computed(() => this.bcfApiService.projects());
  protected selectedProject = computed(() => this.bcfApiService.selectedProject());
  protected serverTopics = computed(() => this.bcfApiService.topicsFilteredBySelection());
  protected selectedServerTopic = computed(() => this.bcfApiService.selectedTopic());
  protected serverComments = computed(() => this.bcfApiService.comments());
  protected isLoadingServerBcf = computed(() => this.bcfApiService.isLoading());
  protected showClosedTopics = computed(() => this.bcfApiService.showClosedTopics());
  protected serverError = computed(() => this.bcfApiService.error());
  protected openTopicsCount = computed(() => this.bcfApiService.openTopicsCount());
  protected totalTopicsCount = computed(() => this.bcfApiService.totalTopicsCount());

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId) && this.authService.isAuthenticated()) {
      this.useServerBcf.set(true);
      this.bcfApiService.fetchProjects();
    }
  }

  ngAfterViewInit(): void {
    if (isPlatformBrowser(this.platformId) && this.ifcViewerFrame) {
      this.ifcViewerService.setIframe(this.ifcViewerFrame.nativeElement);
    }
  }

  ngOnDestroy(): void {
    this.bcfApiService.stopPolling();
    this.revokeAllSnapshots();
  }

  // ═══════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════
  openLoginModal(): void {
    this.showLoginModal.set(true);
    this.loginUsername = '';
    this.loginPassword = '';
  }

  closeLoginModal(): void {
    this.showLoginModal.set(false);
  }

  async submitLogin(): Promise<void> {
    const success = await this.authService.login(
      this.loginUsername,
      this.loginPassword
    );
    
    if (success) {
      this.closeLoginModal();
      this.useServerBcf.set(true);
      await this.bcfApiService.fetchProjects();
      
      // Show project selector if multiple projects
      if (this.projects().length > 1) {
        this.showProjectSelector.set(true);
      }
    }
  }

  logout(): void {
    this.authService.logout();
    this.bcfApiService.stopPolling();
    this.bcfApiService.projects.set([]);
    this.bcfApiService.selectedProject.set(null);
    this.bcfApiService.topics.set([]);
    this.useServerBcf.set(false);
  }

  // ═══════════════════════════════════════════
  // PROJECT SELECTION
  // ═══════════════════════════════════════════
  openProjectSelector(): void {
    this.showProjectSelector.set(true);
  }

  closeProjectSelector(): void {
    this.showProjectSelector.set(false);
  }

  selectProject(project: BcfProject): void {
    this.bcfApiService.selectProject(project);
    this.showProjectSelector.set(false);
    this.expandedTopicGuid.set(null);
  }

  // ═══════════════════════════════════════════
  // BCF SERVER TOPICS
  // ═══════════════════════════════════════════
  toggleExpandTopic(topic: BcfApiTopic): void {
    const current = this.expandedTopicGuid();
    if (current === topic.guid) {
      this.revokeTopicSnapshots(topic.guid);
      this.expandedTopicGuid.set(null);
      this.bcfApiService.selectTopic(null);
    } else {
      if (current) this.revokeTopicSnapshots(current);
      this.expandedTopicGuid.set(topic.guid);
      this.bcfApiService.selectTopic(topic);
      this.loadTopicSnapshots(topic.guid);
    }
  }

  isTopicExpanded(topicGuid: string): boolean {
    return this.expandedTopicGuid() === topicGuid;
  }

  toggleShowClosed(): void {
    this.bcfApiService.toggleShowClosed();
  }

  openCreateTopicModal(): void {
    this.showCreateTopicModal.set(true);
    this.newTopicTitle = '';
    this.newTopicDescription = '';
    this.newTopicPriority = 'Normal';
  }

  closeCreateTopicModal(): void {
    this.showCreateTopicModal.set(false);
  }

  async createTopic(): Promise<void> {
    if (!this.newTopicTitle.trim()) return;
    
    await this.bcfApiService.createTopic({
      title: this.newTopicTitle,
      description: this.newTopicDescription || undefined,
      priority: this.newTopicPriority,
      topic_status: 'Open'
    });
    
    this.closeCreateTopicModal();
  }

  async submitComment(topicGuid: string): Promise<void> {
    if (!this.newComment.trim()) return;
    
    const success = await this.bcfApiService.addComment(topicGuid, this.newComment);
    if (success) {
      this.newComment = '';
    }
  }

  async closeServerTopic(topic: BcfApiTopic, event: Event): Promise<void> {
    event.stopPropagation();
    await this.bcfApiService.updateTopicStatus(topic.guid, 'Closed');
  }

  formatDate(dateStr: string): string {
    return this.bcfApiService.formatDate(dateStr);
  }

  formatDateTime(dateStr: string): string {
    return this.bcfApiService.formatDateTime(dateStr);
  }

  // ═══════════════════════════════════════════
  // BCF File Handling
  // ═══════════════════════════════════════════
  onBcfDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingBcf = true;
  }

  onBcfDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingBcf = false;
  }

  async onBcfDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingBcf = false;

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.name.toLowerCase().endsWith('.bcf') || file.name.toLowerCase().endsWith('.bcfzip')) {
        await this.loadBcfFile(file);
      }
    }
  }

  async onBcfFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      await this.loadBcfFile(input.files[0]);
    }
  }

  private async loadBcfFile(file: File): Promise<void> {
    try {
      this.useServerBcf.set(false);
      await this.bcfService.loadBcfFile(file);
    } catch (error) {
      console.error('Failed to load BCF file:', error);
      alert('Failed to load BCF file. Please try again.');
    }
  }

  selectFileTopic(topic: BcfTopic): void {
    this.bcfService.selectTopic(topic);
  }

  getStatusClass(status: string): string {
    return this.bcfApiService.getStatusClass(status);
  }

  getPriorityClass(priority?: string): string {
    return this.bcfApiService.getPriorityClass(priority);
  }

  /** For template: iterate over IFC properties object keys */
  protected objectKeys(obj: Record<string, unknown>): string[] {
    return Object.keys(obj);
  }

  /** For template: whether value is a property set object (not Name, not array) */
  protected isPsetValue(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
  }

  /** For template: iterate over IFC property set key-value pairs */
  protected objectEntries(val: unknown): [string, unknown][] {
    return this.isPsetValue(val) ? Object.entries(val) : [];
  }

  /** For template: display IFC property value (handles objects so we never show [object Object]) */
  protected formatPropertyValue(val: unknown): string {
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') {
      try {
        return JSON.stringify(val);
      } catch {
        return String(val);
      }
    }
    return String(val);
  }

  // ═══════════════════════════════════════════
  // SELECTION MANAGEMENT
  // ═══════════════════════════════════════════
  
  /**
   * Clear all selections - called on ESC key
   */
  clearAllSelections(): void {
    // Clear BCF topic selection
    this.bcfApiService.selectTopic(null);
    this.expandedTopicGuid.set(null);

    // Clear file-based BCF selection
    this.bcfService.selectTopic(null);

    // Clear IFC viewer element selection and linked highlight
    this.ifcViewerService.clearSelection();
    this.ifcViewerService.clearLinkedHighlight();
  }

  /** Persist selected IFC object(s) into the topic viewpoint (create or update), then highlight. */
  async highlightTopicLink(topic: BcfApiTopic): Promise<void> {
    this.linkFeedbackMessage.set(null);
    const currentGuids = [this.ifcViewerService.selectedIfcGlobalId()].filter(Boolean) as string[];
    if (!currentGuids.length) {
      this.linkFeedbackMessage.set('Select an IFC object in the model first');
      return;
    }
    const viewpoints = await this.bcfApiService.fetchViewpoints(topic.guid);
    const mergedSelection = mergeSelectionWithViewpoints(viewpoints, currentGuids);
    const mergedGuids = mergedSelection.map(s => s.ifc_guid);

    const existing = viewpoints.length > 0 ? viewpoints[0] : null;
    const updated = existing
      ? await this.bcfApiService.updateViewpoint(topic.guid, existing.guid, { components: { selection: mergedSelection } })
      : await this.bcfApiService.createViewpoint(topic.guid, { components: { selection: mergedSelection } });

    if (updated == null) {
      this.linkFeedbackMessage.set('Failed to save link to topic');
      return;
    }
    this.ifcViewerService.highlightLinked(mergedGuids, this.linkHighlightColor());
    this.linkFeedbackMessage.set('Linked');
    setTimeout(() => this.linkFeedbackMessage.set(null), 2500);
  }

  /** Highlight in the viewer the IFC objects already linked to this topic (read-only, no persist). */
  async showTopicLinkInModel(topic: BcfApiTopic): Promise<void> {
    let guids = topic.related_ifc_guids;
    if (!guids?.length) {
      const viewpoints = await this.bcfApiService.fetchViewpoints(topic.guid);
      guids = extractIfcGuidsFromViewpoints(viewpoints);
    }
    if (!guids?.length) return;
    this.ifcViewerService.highlightLinked(guids, this.linkHighlightColor());
  }

  /** Clear the topic-linked highlight in the viewer. */
  clearTopicLinkHighlight(): void {
    this.ifcViewerService.clearLinkedHighlight();
  }

  /** Called when the user changes the link highlight color (color wheel). */
  onLinkHighlightColorChange(hex: string): void {
    const n = parseInt(hex.slice(1), 16);
    if (!Number.isNaN(n)) {
      this.linkHighlightColor.set(n);
      this.linkHighlightColorHex.set(hex);
      const ids = this.ifcViewerService.linkedHighlightGlobalIds();
      if (ids.length > 0) {
        this.ifcViewerService.highlightLinked(ids, n);
      }
    }
  }

  // ═══════════════════════════════════════════
  // SNAPSHOT CAPTURE & DISPLAY
  // ═══════════════════════════════════════════

  /** Capture the current viewer state and POST as a viewpoint snapshot. */
  async captureAndPostSnapshot(topic: BcfApiTopic): Promise<void> {
    this.snapshotFeedbackMessage.set(null);
    const base64 = await this.ifcViewerService.requestScreenshot();
    if (!base64) {
      this.snapshotFeedbackMessage.set('Could not capture screenshot');
      setTimeout(() => this.snapshotFeedbackMessage.set(null), 3000);
      return;
    }

    const result = await this.bcfApiService.createViewpoint(topic.guid, {
      snapshot: { snapshot_type: 'png', snapshot_data: base64 },
    });

    if (result) {
      this.snapshotFeedbackMessage.set('Snapshot saved');
      this.loadTopicSnapshots(topic.guid);
    } else {
      this.snapshotFeedbackMessage.set('Failed to save snapshot');
    }
    setTimeout(() => this.snapshotFeedbackMessage.set(null), 3000);
  }

  /** Fetch all viewpoint snapshots for a topic and cache their Object URLs. */
  async loadTopicSnapshots(topicGuid: string): Promise<void> {
    const viewpoints = await this.bcfApiService.fetchViewpoints(topicGuid);
    const withSnap = viewpoints.filter(vp => vp.snapshot != null);
    if (!withSnap.length) return;

    let cache = this.topicSnapshotCache.get(topicGuid);
    if (!cache) {
      cache = new Map();
      this.topicSnapshotCache.set(topicGuid, cache);
    }

    for (const vp of withSnap) {
      if (cache.has(vp.guid)) continue;
      const url = await this.bcfApiService.fetchSnapshotBlob(topicGuid, vp.guid);
      if (url) {
        cache.set(vp.guid, url);
      }
    }
    this.topicSnapshotVersion.update(v => v + 1);
  }

  /** Template helper: get snapshot Object URLs for a topic. */
  getTopicSnapshotUrls(topicGuid: string): string[] {
    void this.topicSnapshotVersion();
    const cache = this.topicSnapshotCache.get(topicGuid);
    return cache ? Array.from(cache.values()) : [];
  }

  /** Open the snapshot lightbox with the given image URL. */
  openSnapshotLightbox(url: string): void {
    this.enlargedSnapshotUrl.set(url);
  }

  /** Close the snapshot lightbox. */
  closeSnapshotLightbox(): void {
    this.enlargedSnapshotUrl.set(null);
  }

  /** Open file picker and upload selected image as a BCF viewpoint snapshot for the topic. */
  uploadSnapshotFromFile(topic: BcfApiTopic): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/jpg';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const snapshotType = file.type === 'image/png' ? 'png' : 'jpg';
      const reader = new FileReader();
      reader.addEventListener('load', async () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
        if (!base64) {
          this.snapshotFeedbackMessage.set('Could not read image');
          setTimeout(() => this.snapshotFeedbackMessage.set(null), 3000);
          return;
        }
        this.snapshotFeedbackMessage.set(null);
        const result = await this.bcfApiService.createViewpoint(topic.guid, {
          snapshot: { snapshot_type: snapshotType, snapshot_data: base64 },
        });
        if (result) {
          this.snapshotFeedbackMessage.set('Image uploaded');
          this.loadTopicSnapshots(topic.guid);
        } else {
          this.snapshotFeedbackMessage.set('Failed to upload image');
        }
        setTimeout(() => this.snapshotFeedbackMessage.set(null), 3000);
      });
      reader.readAsDataURL(file);
    });
    document.body.appendChild(input);
    input.click();
  }

  /** Revoke Object URLs for a single topic. */
  private revokeTopicSnapshots(topicGuid: string): void {
    const cache = this.topicSnapshotCache.get(topicGuid);
    if (cache) {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      this.topicSnapshotCache.delete(topicGuid);
      this.topicSnapshotVersion.update(v => v + 1);
    }
  }

  /** Revoke all cached Object URLs. */
  private revokeAllSnapshots(): void {
    for (const cache of this.topicSnapshotCache.values()) {
      for (const url of cache.values()) URL.revokeObjectURL(url);
    }
    this.topicSnapshotCache.clear();
  }
}
