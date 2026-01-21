import { Injectable, signal, computed, OnDestroy, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { AuthService } from './auth.service';
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

@Injectable({
  providedIn: 'root'
})
export class BcfApiService implements OnDestroy {
  private platformId = inject(PLATFORM_ID);
  private http = inject(HttpClient);
  private authService = inject(AuthService);
  
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  
  // State signals
  public projects = signal<BcfProject[]>([]);
  public selectedProject = signal<BcfProject | null>(null);
  public topics = signal<BcfApiTopic[]>([]);
  public selectedTopic = signal<BcfApiTopic | null>(null);
  public comments = signal<BcfApiComment[]>([]);
  public isLoading = signal(false);
  public error = signal<string | null>(null);
  public showClosedTopics = signal(false);
  
  // Element filter - filter topics by IFC element GUID
  public elementGuidFilter = signal<string | null>(null);
  
  // Computed: filter topics based on showClosedTopics AND element filter
  public filteredTopics = computed(() => {
    let topics = this.topics();
    const showClosed = this.showClosedTopics();
    const elementFilter = this.elementGuidFilter();
    
    // Filter by closed status
    if (!showClosed) {
      topics = topics.filter(t => 
        !t.topic_status.toLowerCase().includes('closed') &&
        !t.topic_status.toLowerCase().includes('resolved')
      );
    }
    
    // Filter by element GUID if set
    if (elementFilter) {
      topics = topics.filter(t => 
        t.related_ifc_guids?.includes(elementFilter)
      );
    }
    
    return topics;
  });
  
  // Whether element filter is active
  public isElementFilterActive = computed(() => this.elementGuidFilter() !== null);
  
  public openTopicsCount = computed(() => {
    return this.topics().filter(t => 
      !t.topic_status.toLowerCase().includes('closed') &&
      !t.topic_status.toLowerCase().includes('resolved')
    ).length;
  });
  
  public totalTopicsCount = computed(() => this.topics().length);

  ngOnDestroy(): void {
    this.stopPolling();
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
      
      this.topics.set(sorted);
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

  // ═══════════════════════════════════════════
  // POLLING
  // ═══════════════════════════════════════════
  startPolling(projectId: string, intervalMs: number = 5000): void {
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
  // ELEMENT FILTER
  // ═══════════════════════════════════════════
  setElementFilter(guid: string | null): void {
    this.elementGuidFilter.set(guid);
  }
  
  clearElementFilter(): void {
    this.elementGuidFilter.set(null);
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
