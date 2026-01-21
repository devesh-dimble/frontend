import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, computed, PLATFORM_ID, inject, signal, HostListener, effect } from '@angular/core';
import { isPlatformBrowser, CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';
import { IfcViewerService } from './services/ifc-viewer.service';
import { BcfService, BcfTopic } from './services/bcf.service';
import { AuthService } from './services/auth.service';
import { BcfApiService, BcfApiTopic, BcfProject } from './services/bcf-api.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, CommonModule, FormsModule, DatePipe],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements AfterViewInit, OnDestroy {
  
  // ESC key listener to cancel selection
  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.clearAllSelections();
  }
  @ViewChild('viewerContainer') viewerContainer!: ElementRef<HTMLElement>;
  
  private platformId = inject(PLATFORM_ID);
  protected ifcViewer = inject(IfcViewerService);
  protected bcfService = inject(BcfService);
  protected authService = inject(AuthService);
  protected bcfApiService = inject(BcfApiService);
  
  protected isDraggingIfc = false;
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
  
  // Computed properties from IFC service
  protected isLoadingIfc = computed(() => this.ifcViewer.isLoading());
  protected hasModel = computed(() => this.ifcViewer.loadedModel() !== null);
  protected selectedElement = computed(() => this.ifcViewer.selectedElement());
  protected loadingProgress = computed(() => this.ifcViewer.loadingProgress());
  
  // File-based BCF
  protected isLoadingFileBcf = computed(() => this.bcfService.isLoading());
  protected fileBcfTopics = computed(() => this.bcfService.topics());
  protected selectedFileTopic = computed(() => this.bcfService.selectedTopic());
  
  // Auth
  protected isAuthenticated = computed(() => this.authService.isAuthenticated());
  protected isLoggingIn = computed(() => this.authService.isLoggingIn());
  protected loginError = computed(() => this.authService.loginError());
  protected currentUser = computed(() => this.authService.user());
  
  // Server BCF
  protected projects = computed(() => this.bcfApiService.projects());
  protected selectedProject = computed(() => this.bcfApiService.selectedProject());
  protected serverTopics = computed(() => this.bcfApiService.filteredTopics());
  protected selectedServerTopic = computed(() => this.bcfApiService.selectedTopic());
  protected serverComments = computed(() => this.bcfApiService.comments());
  protected isLoadingServerBcf = computed(() => this.bcfApiService.isLoading());
  protected showClosedTopics = computed(() => this.bcfApiService.showClosedTopics());
  protected serverError = computed(() => this.bcfApiService.error());
  protected openTopicsCount = computed(() => this.bcfApiService.openTopicsCount());
  protected totalTopicsCount = computed(() => this.bcfApiService.totalTopicsCount());
  
  // Element filter state
  protected isElementFilterActive = computed(() => this.bcfApiService.isElementFilterActive());
  protected elementGuidFilter = computed(() => this.bcfApiService.elementGuidFilter());
  
  // Effect to sync IFC selection with BCF filter
  private selectionEffect = effect(() => {
    const selected = this.selectedElement();
    if (selected?.guid) {
      // When an IFC element is selected, filter BCF topics by its GUID
      this.bcfApiService.setElementFilter(selected.guid);
    }
    // Note: We don't auto-clear the filter when selection is null
    // The ESC key or explicit action clears both
  });

  async ngAfterViewInit(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) return;
    
    try {
      await this.ifcViewer.initialize(this.viewerContainer.nativeElement);
    } catch (error) {
      console.error('Failed to initialize viewer:', error);
    }
    
    // If already authenticated, switch to server mode and fetch projects
    if (this.authService.isAuthenticated()) {
      this.useServerBcf.set(true);
      await this.bcfApiService.fetchProjects();
    }
  }

  ngOnDestroy(): void {
    this.ifcViewer.dispose();
    this.bcfApiService.stopPolling();
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
      this.expandedTopicGuid.set(null);
      this.bcfApiService.selectTopic(null);
    } else {
      this.expandedTopicGuid.set(topic.guid);
      this.bcfApiService.selectTopic(topic);
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
  // IFC File Handling
  // ═══════════════════════════════════════════
  onIfcDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingIfc = true;
  }

  onIfcDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingIfc = false;
  }

  async onIfcDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingIfc = false;

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.name.toLowerCase().endsWith('.ifc')) {
        await this.loadIfcFile(file);
      }
    }
  }

  async onIfcFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      await this.loadIfcFile(input.files[0]);
    }
  }

  private async loadIfcFile(file: File): Promise<void> {
    try {
      await this.ifcViewer.loadIfcFile(file);
    } catch (error) {
      console.error('Failed to load IFC file:', error);
      alert('Failed to load IFC file. Please try again.');
    }
  }

  /**
   * Load the bundled IFC model (BW_6533630.ifc)
   */
  async loadBundledModel(): Promise<void> {
    try {
      await this.ifcViewer.loadIfcFromPath('./BW_6533630.ifc');
    } catch (error) {
      console.error('Failed to load bundled IFC model:', error);
      alert('Failed to load the IFC model. Please try again.');
    }
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

  // ═══════════════════════════════════════════
  // SELECTION MANAGEMENT
  // ═══════════════════════════════════════════
  
  /**
   * Clear all selections - called on ESC key
   * Clears: IFC element selection, BCF element filter, property view
   */
  clearAllSelections(): void {
    // Clear IFC element selection
    this.ifcViewer.clearSelection();
    
    // Clear BCF element filter
    this.bcfApiService.clearElementFilter();
    
    // Clear BCF topic selection
    this.bcfApiService.selectTopic(null);
    this.expandedTopicGuid.set(null);
    
    // Clear file-based BCF selection
    this.bcfService.selectTopic(null);
  }
  
  /**
   * Clear only the BCF element filter (but keep IFC selection visible)
   */
  clearElementFilter(): void {
    this.bcfApiService.clearElementFilter();
  }
}
