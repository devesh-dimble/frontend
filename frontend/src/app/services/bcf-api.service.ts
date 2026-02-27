import { Injectable, signal, computed, effect, OnDestroy, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { AuthService } from './auth.service';
import { IfcViewerService } from './ifc-viewer.service';
import { environment } from '../../environments/environment';
import { firstValueFrom } from 'rxjs';

// BCF 3.0 API Types
export interface BcfProject {
  project_id: string;
  name: string;
  description?: string;
}

export interface BcfApiTopic {
  guid: string;
  topic_type?: string;
  topic_status: string;
  reference_links?: string[];
  title: string;
  priority?: string;
  index?: number;
  labels?: string[];
  creation_date: string;
  creation_author: string;
  modified_date?: string;
  modified_author?: string;
  assigned_to?: string;
  stage?: string;
  description?: string;
  due_date?: string;
  // Related IFC elements (GUIDs) - populated from viewpoints/components
  related_ifc_guids?: string[];
}

export interface BcfApiComment {
  guid: string;
  date: string;
  author: string;
  comment: string;
  topic_guid: string;
  viewpoint_guid?: string;
  modified_date?: string;
  modified_author?: string;
}

export interface CreateTopicRequest {
  title: string;
  description?: string;
  topic_type?: string;
  topic_status?: string;
  priority?: string;
  assigned_to?: string;
}

export interface CreateCommentRequest {
  comment: string;
}

/** BCF viewpoint response; components.selection holds linked IFC elements. */
export interface BcfViewpointResponse {
  guid: string;
  components?: {
    selection?: { ifc_guid: string }[];
    visibility?: unknown;
  };
  snapshot?: { snapshot_type: string } | null;
}

/** Request body for creating or updating a viewpoint (components.selection). */
export interface BcfViewpointCreateRequest {
  components?: {
    selection?: { ifc_guid: string }[];
    visibility?: unknown;
  };
  camera?: unknown;
  snapshot?: {
    snapshot_type: 'png' | 'jpg';
    snapshot_data: string;
  };
}

/** Extract IFC GlobalIds from viewpoint components.selection. */
export function extractIfcGuidsFromViewpoints(viewpoints: BcfViewpointResponse[]): string[] {
  const guids: string[] = [];
  for (const vp of viewpoints) {
    for (const sel of vp.components?.selection ?? []) {
      if (sel?.ifc_guid) guids.push(sel.ifc_guid);
    }
  }
  return [...new Set(guids)];
}

/** Merge existing viewpoint selections with new GlobalIds; returns deduplicated selection for API. */
export function mergeSelectionWithViewpoints(
  viewpoints: BcfViewpointResponse[],
  newGuids: string[]
): { ifc_guid: string }[] {
  const existing = extractIfcGuidsFromViewpoints(viewpoints);
  const combined = [...new Set([...existing, ...newGuids])];
  return combined.map(ifc_guid => ({ ifc_guid }));
}

@Injectable({
  providedIn: 'root'
})
export class BcfApiService implements OnDestroy {
  private platformId = inject(PLATFORM_ID);
  private http = inject(HttpClient);
  private authService = inject(AuthService);
  private ifcViewerService = inject(IfcViewerService);
  
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  
  /** Cache: topic guid -> set of linked IFC GlobalIds. Populated when filtering by selection. */
  private topicLinkedGuidsCache = signal<Map<string, Set<string>>>(new Map());
  
  // State signals
  public projects = signal<BcfProject[]>([]);
  public selectedProject = signal<BcfProject | null>(null);
  public topics = signal<BcfApiTopic[]>([]);
  public selectedTopic = signal<BcfApiTopic | null>(null);
  public comments = signal<BcfApiComment[]>([]);
  public isLoading = signal(false);
  public error = signal<string | null>(null);
  public showClosedTopics = signal(false);
  
  // Computed: filter topics based on showClosedTopics
  public filteredTopics = computed(() => {
    let topics = this.topics();
    const showClosed = this.showClosedTopics();
    
    if (!showClosed) {
      topics = topics.filter(t => 
        !t.topic_status.toLowerCase().includes('closed') &&
        !t.topic_status.toLowerCase().includes('resolved')
      );
    }
    
    return topics;
  });
  
  /** Topics filtered by selected IFC object (backward link). When no object selected, returns filteredTopics. */
  public topicsFilteredBySelection = computed(() => {
    const filtered = this.filteredTopics();
    const selectedId = this.ifcViewerService.selectedIfcGlobalId();
    if (!selectedId) return filtered;
    const cache = this.topicLinkedGuidsCache();
    return filtered.filter(t => {
      const guids = t.related_ifc_guids?.length
        ? new Set(t.related_ifc_guids)
        : cache.get(t.guid);
      return guids?.has(selectedId) ?? false;
    });
  });
  
  public openTopicsCount = computed(() => {
    return this.topics().filter(t => 
      !t.topic_status.toLowerCase().includes('closed') &&
      !t.topic_status.toLowerCase().includes('resolved')
    ).length;
  });
  
  public totalTopicsCount = computed(() => this.topics().length);

  constructor() {
    effect(() => {
      const selectedId = this.ifcViewerService.selectedIfcGlobalId();
      const filtered = this.filteredTopics();
      if (!selectedId || filtered.length === 0) return;
      this.populateCacheForFilteredTopics(filtered);
    });
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  /** Populate cache for topics that don't have related_ifc_guids from API. Runs async. */
  private populateCacheForFilteredTopics(filtered: BcfApiTopic[]): void {
    const cache = new Map(this.topicLinkedGuidsCache());
    const toFetch = filtered.filter(t => !(t.related_ifc_guids?.length) && !cache.has(t.guid));
    if (toFetch.length === 0) return;
    Promise.all(toFetch.map(async (t) => {
      const vps = await this.fetchViewpoints(t.guid);
      const guids = extractIfcGuidsFromViewpoints(vps);
      return [t.guid, new Set(guids)] as const;
    })).then(entries => {
      const next = new Map(this.topicLinkedGuidsCache());
      for (const [guid, set] of entries) next.set(guid, set);
      this.topicLinkedGuidsCache.set(next);
    });
  }

  private getHeaders(): HttpHeaders {
    const token = this.authService.token();
    let headers = new HttpHeaders({
      'Content-Type': 'application/json'
    });
    
    if (token) {
      headers = headers.set('Authorization', `Bearer ${token}`);
    }
    
    return headers;
  }

  // ═══════════════════════════════════════════
  // PROJECTS
  // ═══════════════════════════════════════════
  async fetchProjects(): Promise<void> {
    this.isLoading.set(true);
    this.error.set(null);
    
    try {
      const response = await firstValueFrom(
        this.http.get<BcfProject[]>(
          `${environment.bcfApiUrl}/projects`,
          { headers: this.getHeaders() }
        )
      );
      
      this.projects.set(response || []);
      
      // Auto-select first project if only one exists
      if (response && response.length === 1) {
        this.selectProject(response[0]);
      }
    } catch (err: unknown) {
      const error = err as { message?: string; status?: number };
      console.error('Failed to fetch projects:', error);
      this.error.set(error.message || 'Failed to fetch projects');
      
      if (error.status === 401) {
        this.authService.logout();
      }
    } finally {
      this.isLoading.set(false);
    }
  }

  selectProject(project: BcfProject | null): void {
    this.selectedProject.set(project);
    this.topics.set([]);
    this.selectedTopic.set(null);
    this.comments.set([]);
    this.topicLinkedGuidsCache.set(new Map());
    
    if (project) {
      this.fetchTopics(project.project_id);
      this.startPolling(project.project_id);
    } else {
      this.stopPolling();
    }
  }

  // ═══════════════════════════════════════════
  // TOPICS
  // ═══════════════════════════════════════════
  async fetchTopics(projectId: string): Promise<void> {
    this.error.set(null);
    
    try {
      const response = await firstValueFrom(
        this.http.get<BcfApiTopic[]>(
          `${environment.bcfApiUrl}/projects/${projectId}/topics`,
          { headers: this.getHeaders() }
        )
      );
      
      // Sort by creation date, newest first
      const sorted = (response || []).sort((a, b) => 
        new Date(b.creation_date).getTime() - new Date(a.creation_date).getTime()
      );

      // Only update topics (and thus the UI) when the payload actually changed.
      const current = this.topics();
      const sameLength = current.length === sorted.length;
      let isDifferent = !sameLength;
      if (!isDifferent) {
        for (let i = 0; i < current.length; i++) {
          const a = current[i];
          const b = sorted[i];
          if (
            a.guid !== b.guid ||
            a.topic_status !== b.topic_status ||
            a.title !== b.title ||
            a.priority !== b.priority ||
            a.assigned_to !== b.assigned_to ||
            a.description !== b.description
          ) {
            isDifferent = true;
            break;
          }
        }
      }

      if (!isDifferent) {
        // No changes: keep existing topics and cache to avoid flicker.
        return;
      }

      // Update topics and prune cache to only keep entries for existing topic GUIDs.
      this.topics.set(sorted);
      const newGuids = new Set(sorted.map(t => t.guid));
      const oldCache = this.topicLinkedGuidsCache();
      const pruned = new Map<string, Set<string>>();
      for (const [guid, set] of oldCache.entries()) {
        if (newGuids.has(guid)) {
          pruned.set(guid, set);
        }
      }
      this.topicLinkedGuidsCache.set(pruned);
    } catch (err: unknown) {
      const error = err as { message?: string };
      console.error('Failed to fetch topics:', error);
      this.error.set(error.message || 'Failed to fetch topics');
    }
  }

  async createTopic(data: CreateTopicRequest): Promise<BcfApiTopic | null> {
    const project = this.selectedProject();
    if (!project) return null;
    
    this.isLoading.set(true);
    
    try {
      const response = await firstValueFrom(
        this.http.post<BcfApiTopic>(
          `${environment.bcfApiUrl}/projects/${project.project_id}/topics`,
          data,
          { headers: this.getHeaders() }
        )
      );
      
      if (response) {
        // Refresh topics list
        await this.fetchTopics(project.project_id);
        return response;
      }
      return null;
    } catch (err: unknown) {
      const error = err as { message?: string };
      console.error('Failed to create topic:', error);
      this.error.set(error.message || 'Failed to create topic');
      return null;
    } finally {
      this.isLoading.set(false);
    }
  }

  async updateTopicStatus(topicGuid: string, newStatus: string): Promise<boolean> {
    const project = this.selectedProject();
    if (!project) return false;
    
    try {
      await firstValueFrom(
        this.http.put(
          `${environment.bcfApiUrl}/projects/${project.project_id}/topics/${topicGuid}`,
          { topic_status: newStatus },
          { headers: this.getHeaders() }
        )
      );
      
      await this.fetchTopics(project.project_id);
      return true;
    } catch (err: unknown) {
      const error = err as { message?: string };
      console.error('Failed to update topic:', error);
      this.error.set(error.message || 'Failed to update topic');
      return false;
    }
  }

  selectTopic(topic: BcfApiTopic | null): void {
    this.selectedTopic.set(topic);
    this.comments.set([]);
    
    if (topic) {
      this.fetchComments(topic.guid);
    }
  }

  // ═══════════════════════════════════════════
  // COMMENTS
  // ═══════════════════════════════════════════
  async fetchComments(topicGuid: string): Promise<void> {
    const project = this.selectedProject();
    if (!project) return;
    
    try {
      const response = await firstValueFrom(
        this.http.get<BcfApiComment[]>(
          `${environment.bcfApiUrl}/projects/${project.project_id}/topics/${topicGuid}/comments`,
          { headers: this.getHeaders() }
        )
      );
      
      // Sort by date, oldest first
      const sorted = (response || []).sort((a, b) => 
        new Date(a.date).getTime() - new Date(b.date).getTime()
      );
      
      this.comments.set(sorted);
    } catch (err: unknown) {
      console.error('Failed to fetch comments:', err);
    }
  }

  async addComment(topicGuid: string, commentText: string): Promise<boolean> {
    const project = this.selectedProject();
    if (!project) return false;
    
    try {
      await firstValueFrom(
        this.http.post<BcfApiComment>(
          `${environment.bcfApiUrl}/projects/${project.project_id}/topics/${topicGuid}/comments`,
          { comment: commentText } as CreateCommentRequest,
          { headers: this.getHeaders() }
        )
      );
      
      // Refresh comments
      await this.fetchComments(topicGuid);
      return true;
    } catch (err: unknown) {
      const error = err as { message?: string };
      console.error('Failed to add comment:', error);
      this.error.set(error.message || 'Failed to add comment');
      return false;
    }
  }

  /** Fetch viewpoints for a topic (BCF 3.0). Used to get linked IFC GUIDs from components.selection. */
  async fetchViewpoints(topicGuid: string): Promise<BcfViewpointResponse[]> {
    const project = this.selectedProject();
    if (!project) return [];

    try {
      const response = await firstValueFrom(
        this.http.get<BcfViewpointResponse[]>(
          `${environment.bcfApiUrl}/projects/${project.project_id}/topics/${topicGuid}/viewpoints`,
          { headers: this.getHeaders() }
        )
      );
      return response ?? [];
    } catch (err: unknown) {
      console.error('Failed to fetch viewpoints:', err);
      return [];
    }
  }

  /** Create a viewpoint for a topic (POST). Persists components.selection. */
  async createViewpoint(topicGuid: string, body: BcfViewpointCreateRequest): Promise<BcfViewpointResponse | null> {
    const project = this.selectedProject();
    if (!project) return null;

    try {
      const created = await firstValueFrom(
        this.http.post<BcfViewpointResponse>(
          `${environment.bcfApiUrl}/projects/${project.project_id}/topics/${topicGuid}/viewpoints`,
          body,
          { headers: this.getHeaders() }
        )
      );
      return created ?? null;
    } catch (err: unknown) {
      console.error('Failed to create viewpoint:', err);
      return null;
    }
  }

  /** Update an existing viewpoint (PUT). Use to merge components.selection. */
  async updateViewpoint(
    topicGuid: string,
    viewpointGuid: string,
    body: Partial<BcfViewpointCreateRequest>
  ): Promise<BcfViewpointResponse | null> {
    const project = this.selectedProject();
    if (!project) return null;

    try {
      const updated = await firstValueFrom(
        this.http.put<BcfViewpointResponse>(
          `${environment.bcfApiUrl}/projects/${project.project_id}/topics/${topicGuid}/viewpoints/${viewpointGuid}`,
          body,
          { headers: this.getHeaders() }
        )
      );
      return updated ?? null;
    } catch (err: unknown) {
      console.error('Failed to update viewpoint:', err);
      return null;
    }
  }

  /** Fetch a viewpoint's snapshot image as a blob Object URL. Returns null on error/404. */
  async fetchSnapshotBlob(topicGuid: string, viewpointGuid: string): Promise<string | null> {
    const project = this.selectedProject();
    if (!project) return null;

    try {
      const blob = await firstValueFrom(
        this.http.get(
          `${environment.bcfApiUrl}/projects/${project.project_id}/topics/${topicGuid}/viewpoints/${viewpointGuid}/snapshot`,
          { headers: this.getHeaders(), responseType: 'blob' }
        )
      );
      return blob ? URL.createObjectURL(blob) : null;
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════
  // POLLING
  // ═══════════════════════════════════════════
  startPolling(projectId: string, intervalMs: number = 3000): void {
    if (!isPlatformBrowser(this.platformId)) return;
    
    this.stopPolling();
    
    this.pollingInterval = setInterval(() => {
      this.fetchTopics(projectId);
      
      // Also refresh comments if a topic is selected
      const selectedTopic = this.selectedTopic();
      if (selectedTopic) {
        this.fetchComments(selectedTopic.guid);
      }
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  // ═══════════════════════════════════════════
  // UI HELPERS
  // ═══════════════════════════════════════════
  toggleShowClosed(): void {
    this.showClosedTopics.update(v => !v);
  }

  getStatusClass(status: string): string {
    const normalized = status.toLowerCase();
    if (normalized.includes('closed') || normalized.includes('resolved')) return 'resolved';
    if (normalized.includes('progress')) return 'in-progress';
    return 'open';
  }

  getPriorityClass(priority?: string): string {
    if (!priority) return 'normal';
    const normalized = priority.toLowerCase();
    if (normalized.includes('critical')) return 'critical';
    if (normalized.includes('high')) return 'high';
    if (normalized.includes('low')) return 'low';
    return 'normal';
  }

  formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric',
        year: 'numeric'
      });
    } catch {
      return dateStr;
    }
  }

  formatDateTime(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      return date.toLocaleString('en-US', { 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return dateStr;
    }
  }
}
