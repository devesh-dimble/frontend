import { Injectable, signal, computed, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { firstValueFrom } from 'rxjs';

export interface LoginCredentials {
  userName: string;
  password: string;
}

export interface AuthResponse {
  token: string;
}

export interface User {
  userName: string;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private platformId = inject(PLATFORM_ID);
  private http = inject(HttpClient);
  
  private readonly tokenKey = 'bcf_jwt_token';
  private readonly userKey = 'bcf_user';
  
  // Signals for reactive state
  private _token = signal<string | null>(this.getStoredToken());
  private _user = signal<User | null>(this.getStoredUser());
  private _isLoggingIn = signal(false);
  private _loginError = signal<string | null>(null);
  
  // Public computed properties
  public isAuthenticated = computed(() => !!this._token());
  public token = computed(() => this._token());
  public user = computed(() => this._user());
  public isLoggingIn = computed(() => this._isLoggingIn());
  public loginError = computed(() => this._loginError());

  private getStoredToken(): string | null {
    if (!isPlatformBrowser(this.platformId)) return null;
    return localStorage.getItem(this.tokenKey);
  }

  private getStoredUser(): User | null {
    if (!isPlatformBrowser(this.platformId)) return null;
    const stored = localStorage.getItem(this.userKey);
    return stored ? JSON.parse(stored) : null;
  }

  async login(userName: string, password: string): Promise<boolean> {
    this._isLoggingIn.set(true);
    this._loginError.set(null);

    try {
      // POST /Authentication/login
      // Request: { "userName": "<username>", "password": "<password>" }
      // Response: { "token": "<JWT>" }
      const response = await firstValueFrom(
        this.http.post<AuthResponse>(
          `${environment.authApiUrl}/Authentication/login`,
          { userName, password } as LoginCredentials
        )
      );

      if (response?.token) {
        this.setToken(response.token);
        this.setUser({ userName });
        return true;
      }
      
      this._loginError.set('Invalid response from server');
      return false;
      
    } catch (error) {
      const httpError = error as HttpErrorResponse;
      console.error('Login error:', httpError);
      
      if (httpError.status === 401) {
        this._loginError.set('Invalid username or password');
      } else if (httpError.status === 0) {
        this._loginError.set('Cannot connect to server. Please check if CORS is enabled.');
      } else if (httpError.status === 404) {
        this._loginError.set('Authentication endpoint not found');
      } else {
        this._loginError.set(httpError.error?.message || `Login failed (${httpError.status})`);
      }
      return false;
    } finally {
      this._isLoggingIn.set(false);
    }
  }

  private setToken(token: string): void {
    if (isPlatformBrowser(this.platformId)) {
      localStorage.setItem(this.tokenKey, token);
    }
    this._token.set(token);
  }

  private setUser(user: User): void {
    if (isPlatformBrowser(this.platformId)) {
      localStorage.setItem(this.userKey, JSON.stringify(user));
    }
    this._user.set(user);
  }

  logout(): void {
    if (isPlatformBrowser(this.platformId)) {
      localStorage.removeItem(this.tokenKey);
      localStorage.removeItem(this.userKey);
    }
    this._token.set(null);
    this._user.set(null);
  }

  getAuthHeaders(): Record<string, string> {
    const token = this._token();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }
}
