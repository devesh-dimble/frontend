import { Injectable, signal } from '@angular/core';
import JSZip from 'jszip';

export interface BcfViewpoint {
  guid: string;
  snapshot?: string; // Base64 image
  camera?: {
    position: { x: number; y: number; z: number };
    direction: { x: number; y: number; z: number };
    up: { x: number; y: number; z: number };
  };
}

export interface BcfComment {
  guid: string;
  date: Date;
  author: string;
  comment: string;
}

export interface BcfTopic {
  guid: string;
  title: string;
  description?: string;
  status: 'Open' | 'Closed' | 'InProgress' | 'Resolved';
  priority?: 'Low' | 'Normal' | 'High' | 'Critical';
  type?: string;
  author?: string;
  creationDate?: Date;
  modifiedDate?: Date;
  assignedTo?: string;
  comments: BcfComment[];
  viewpoints: BcfViewpoint[];
  relatedElements?: string[]; // IFC GUIDs
}

@Injectable({
  providedIn: 'root'
})
export class BcfService {
  public topics = signal<BcfTopic[]>([]);
  public selectedTopic = signal<BcfTopic | null>(null);
  public isLoading = signal(false);

  async loadBcfFile(file: File): Promise<void> {
    this.isLoading.set(true);
    
    try {
      const zip = new JSZip();
      const contents = await zip.loadAsync(file);
      
      const loadedTopics: BcfTopic[] = [];
      
      // Find all topic folders (each topic has a GUID folder)
      const topicFolders = new Set<string>();
      
      contents.forEach((relativePath) => {
        const parts = relativePath.split('/');
        if (parts.length > 1 && parts[0] && this.isGuid(parts[0])) {
          topicFolders.add(parts[0]);
        }
      });

      // Process each topic
      for (const topicGuid of topicFolders) {
        const topic = await this.parseTopic(contents, topicGuid);
        if (topic) {
          loadedTopics.push(topic);
        }
      }

      this.topics.set(loadedTopics);
      
    } catch (error) {
      console.error('Error loading BCF file:', error);
      throw error;
    } finally {
      this.isLoading.set(false);
    }
  }

  private isGuid(str: string): boolean {
    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return guidRegex.test(str);
  }

  private async parseTopic(zip: JSZip, topicGuid: string): Promise<BcfTopic | null> {
    try {
      // Read markup.bcf (XML file with topic info)
      const markupFile = zip.file(`${topicGuid}/markup.bcf`);
      if (!markupFile) return null;

      const markupXml = await markupFile.async('string');
      const parser = new DOMParser();
      const doc = parser.parseFromString(markupXml, 'text/xml');

      const topicElement = doc.querySelector('Topic');
      if (!topicElement) return null;

      // Parse basic topic info
      const topic: BcfTopic = {
        guid: topicGuid,
        title: this.getElementText(topicElement, 'Title') || 'Untitled',
        description: this.getElementText(topicElement, 'Description'),
        status: this.parseStatus(this.getElementText(topicElement, 'TopicStatus')),
        priority: this.parsePriority(this.getElementText(topicElement, 'Priority')),
        type: this.getElementText(topicElement, 'TopicType'),
        author: this.getElementText(topicElement, 'CreationAuthor'),
        creationDate: this.parseDate(this.getElementText(topicElement, 'CreationDate')),
        modifiedDate: this.parseDate(this.getElementText(topicElement, 'ModifiedDate')),
        assignedTo: this.getElementText(topicElement, 'AssignedTo'),
        comments: [],
        viewpoints: [],
        relatedElements: []
      };

      // Parse comments
      const commentElements = doc.querySelectorAll('Comment');
      commentElements.forEach((commentEl) => {
        const comment: BcfComment = {
          guid: commentEl.getAttribute('Guid') || crypto.randomUUID(),
          date: this.parseDate(this.getElementText(commentEl, 'Date')) || new Date(),
          author: this.getElementText(commentEl, 'Author') || 'Unknown',
          comment: this.getElementText(commentEl, 'Comment') || ''
        };
        topic.comments.push(comment);
      });

      // Parse viewpoints and collect related IFC elements from each viewpoint's selection
      const viewpointRefs = doc.querySelectorAll('Viewpoints');
      const allRelatedGuids = new Set<string>();
      for (const vpRef of Array.from(viewpointRefs)) {
        const vpGuid = vpRef.getAttribute('Guid');
        if (vpGuid) {
          const result = await this.parseViewpoint(zip, topicGuid, vpGuid);
          if (result?.viewpoint) {
            topic.viewpoints.push(result.viewpoint);
            for (const g of result.relatedGuids) allRelatedGuids.add(g);
          }
        }
      }
      // Also collect Component/IfcGuid from markup.bcf (some BCF files store selection in markup)
      for (const g of this.extractSelectionGuidsFromViewpointDoc(doc)) allRelatedGuids.add(g);
      if (allRelatedGuids.size > 0) {
        topic.relatedElements = [...allRelatedGuids];
      }

      return topic;
      
    } catch (error) {
      console.error(`Error parsing topic ${topicGuid}:`, error);
      return null;
    }
  }

  private async parseViewpoint(zip: JSZip, topicGuid: string, vpGuid: string): Promise<{ viewpoint: BcfViewpoint; relatedGuids: string[] } | null> {
    try {
      const viewpoint: BcfViewpoint = { guid: vpGuid };
      let relatedGuids: string[] = [];

      // Try to load snapshot
      const snapshotFile = zip.file(`${topicGuid}/snapshot.png`) ||
                          zip.file(`${topicGuid}/${vpGuid}.png`);
      if (snapshotFile) {
        const snapshotData = await snapshotFile.async('base64');
        viewpoint.snapshot = `data:image/png;base64,${snapshotData}`;
      }

      // Parse viewpoint.bcfv for camera position and Components/Selection
      const vpFile = zip.file(`${topicGuid}/viewpoint.bcfv`) ||
                    zip.file(`${topicGuid}/${vpGuid}.bcfv`);
      if (vpFile) {
        const vpXml = await vpFile.async('string');
        const parser = new DOMParser();
        const doc = parser.parseFromString(vpXml, 'text/xml');

        const cameraEl = doc.querySelector('PerspectiveCamera') || doc.querySelector('OrthogonalCamera');
        if (cameraEl) {
          viewpoint.camera = {
            position: {
              x: parseFloat(this.getElementText(cameraEl, 'CameraViewPoint X') || '0'),
              y: parseFloat(this.getElementText(cameraEl, 'CameraViewPoint Y') || '0'),
              z: parseFloat(this.getElementText(cameraEl, 'CameraViewPoint Z') || '0')
            },
            direction: {
              x: parseFloat(this.getElementText(cameraEl, 'CameraDirection X') || '0'),
              y: parseFloat(this.getElementText(cameraEl, 'CameraDirection Y') || '-1'),
              z: parseFloat(this.getElementText(cameraEl, 'CameraDirection Z') || '0')
            },
            up: {
              x: parseFloat(this.getElementText(cameraEl, 'CameraUpVector X') || '0'),
              y: parseFloat(this.getElementText(cameraEl, 'CameraUpVector Y') || '0'),
              z: parseFloat(this.getElementText(cameraEl, 'CameraUpVector Z') || '1')
            }
          };
        }
        relatedGuids = this.extractSelectionGuidsFromViewpointDoc(doc);
      }

      return { viewpoint, relatedGuids };
    } catch {
      return null;
    }
  }

  /** Extract IFC GlobalIds from viewpoint XML (Components/Selection/Component). BCF 2.x / 3.0 style. */
  private extractSelectionGuidsFromViewpointDoc(doc: Document): string[] {
    const guids: string[] = [];
    const components = doc.querySelectorAll('Component');
    for (const comp of Array.from(components)) {
      const guid = comp.getAttribute('IfcGuid') ?? comp.getAttribute('ifc_guid') ?? this.getElementText(comp, 'IfcGuid');
      if (guid && this.isGuid(guid)) guids.push(guid);
    }
    return [...new Set(guids)];
  }

  private getElementText(parent: Element, tagName: string): string | undefined {
    const el = parent.querySelector(tagName);
    return el?.textContent || undefined;
  }

  private parseStatus(status?: string): BcfTopic['status'] {
    if (!status) return 'Open';
    const normalized = status.toLowerCase();
    if (normalized.includes('closed')) return 'Closed';
    if (normalized.includes('progress')) return 'InProgress';
    if (normalized.includes('resolved')) return 'Resolved';
    return 'Open';
  }

  private parsePriority(priority?: string): BcfTopic['priority'] {
    if (!priority) return 'Normal';
    const normalized = priority.toLowerCase();
    if (normalized.includes('critical')) return 'Critical';
    if (normalized.includes('high')) return 'High';
    if (normalized.includes('low')) return 'Low';
    return 'Normal';
  }

  private parseDate(dateStr?: string): Date | undefined {
    if (!dateStr) return undefined;
    try {
      return new Date(dateStr);
    } catch {
      return undefined;
    }
  }

  selectTopic(topic: BcfTopic | null): void {
    this.selectedTopic.set(topic);
  }

  getStatusClass(status: BcfTopic['status']): string {
    switch (status) {
      case 'Closed':
      case 'Resolved':
        return 'resolved';
      case 'InProgress':
        return 'in-progress';
      default:
        return 'open';
    }
  }
}