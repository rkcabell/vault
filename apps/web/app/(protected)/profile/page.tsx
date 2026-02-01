"use client";

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Edit2, Save, X, MapPin, Globe, Mail, Calendar, Loader2 } from 'lucide-react';
import { useAuth } from '@/components/contexts/AuthContext';

type UserProfile = {
  id: string;
  email: string;
  name?: string | null;
  username?: string | null;
  bio?: string | null;
  website?: string | null;
  location?: string | null;
  avatarUrl?: string | null;
  createdAt: string;
};

type ProfileFormData = {
  name: string;
  username: string;
  bio: string;
  website: string;
  location: string;
  avatarUrl: string;
};

const emptyForm: ProfileFormData = {
  name: '',
  username: '',
  bio: '',
  website: '',
  location: '',
  avatarUrl: '',
};

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const data = await response.json();
    if (data?.error || data?.message) return data.error || data.message;
  } catch {
    // Ignore JSON parse errors and use fallback.
  }
  return `${fallback} (${response.status})`;
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

export default function ProfilePage() {
  const { user, setUser, status } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<ProfileFormData>(emptyForm);



  const syncAuthUser = useCallback(
    (nextProfile: UserProfile) => {
      if (status !== "authenticated") return;
      setUser({
        id: nextProfile.id,
        email: nextProfile.email,
        name: nextProfile.name ?? undefined,
        avatarUrl: nextProfile.avatarUrl ?? null,
      });
    },
    [status, setUser],
  );

    const loadProfile = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const res = await fetch("/api/profile", {
        method: "GET",
        credentials: "include",
      });

      if (!res.ok) {
        const message = await readErrorMessage(res, "Failed to load profile.");
        setError(message);
        return;
      }

      const data = await res.json();
      const nextProfile = (data?.profile ?? data) as UserProfile | null;

      if (nextProfile) {
        setProfile(nextProfile);
        setFormData({
          name: nextProfile.name ?? "",
          username: nextProfile.username ?? "",
          bio: nextProfile.bio ?? "",
          website: nextProfile.website ?? "",
          location: nextProfile.location ?? "",
          avatarUrl: nextProfile.avatarUrl ?? "",
        });
        syncAuthUser(nextProfile);
      }
    } catch (error) {
      console.error("Error loading profile:", error);
      setError("Error loading profile. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [syncAuthUser]);


  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const handleSave = async () => {
    if (!profile) return;

    try {
      setSaving(true);
      setError(null);

      const res = await fetch('/api/profile', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          username: formData.username,
          bio: formData.bio,
          website: formData.website,
          location: formData.location,
          avatarUrl: formData.avatarUrl,
        }),
      });

      if (!res.ok) {
        const message = await readErrorMessage(res, 'Failed to update profile.');
        setError(message);
        return;
      }

      const data = await res.json();
      const nextProfile = (data?.profile ?? data) as UserProfile | null;
      if (nextProfile) {
        setProfile(nextProfile);
        setFormData({
          name: nextProfile.name ?? '',
          username: nextProfile.username ?? '',
          bio: nextProfile.bio ?? '',
          website: nextProfile.website ?? '',
          location: nextProfile.location ?? '',
          avatarUrl: nextProfile.avatarUrl ?? '',
        });
        syncAuthUser(nextProfile);
      }

      setIsEditing(false);
    } catch (error) {
      console.error('Error updating profile:', error);
      setError('Error updating profile. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (profile) {
      setFormData({
        name: profile.name ?? '',
        username: profile.username ?? '',
        bio: profile.bio ?? '',
        website: profile.website ?? '',
        location: profile.location ?? '',
        avatarUrl: profile.avatarUrl ?? '',
      });
    }
    setIsEditing(false);
  };

  const initials = useMemo(() => {
    const label = profile?.name || profile?.email || user?.email || '?';
    return label.trim().charAt(0).toUpperCase();
  }, [profile, user]);

  const websiteHref =
    profile?.website && !profile.website.startsWith('http')
      ? `https://${profile.website}`
      : profile?.website;

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/40 dark:from-slate-950 dark:via-slate-950 dark:to-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-600 dark:text-blue-400 animate-spin" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/40 dark:from-slate-950 dark:via-slate-950 dark:to-slate-900 flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">Profile not found</p>
          {error && <p className="mt-2 text-sm text-red-600 dark:text-red-300">{error}</p>}
          <button
            onClick={loadProfile}
            className="mt-4 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/30 dark:from-slate-950 dark:via-slate-950 dark:to-slate-900">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="bg-card text-foreground rounded-2xl shadow-lg shadow-black/10 dark:shadow-black/30 overflow-hidden border border-border/60">
          <div className="h-48 bg-gradient-to-r from-blue-500 via-blue-600 to-cyan-500 dark:from-slate-800 dark:via-slate-900 dark:to-black relative">
            <div className="absolute top-4 right-4">
              {!isEditing ? (
                <button
                  onClick={() => setIsEditing(true)}
                  className="px-4 py-2 bg-white text-blue-600 dark:bg-slate-900 dark:text-blue-200 rounded-lg hover:bg-blue-50 dark:hover:bg-slate-800 transition-colors flex items-center gap-2 font-medium shadow-md border border-border/60"
                >
                  <Edit2 className="w-4 h-4" />
                  Edit Profile
                </button>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={handleCancel}
                    disabled={saving}
                    className="px-4 py-2 bg-white text-slate-600 dark:bg-slate-900 dark:text-slate-200 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors flex items-center gap-2 font-medium shadow-md disabled:opacity-50 border border-border/60"
                  >
                    <X className="w-4 h-4" />
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-4 py-2 bg-white text-blue-600 dark:bg-slate-900 dark:text-blue-200 rounded-lg hover:bg-blue-50 dark:hover:bg-slate-800 transition-colors flex items-center gap-2 font-medium shadow-md disabled:opacity-50 border border-border/60"
                  >
                    {saving ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                    Save
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="px-8 pb-8">
            <div className="flex flex-col items-center -mt-16 mb-6">
              <div className="relative h-28 w-28 rounded-full border-4 border-background shadow-md overflow-hidden bg-muted flex items-center justify-center text-2xl font-semibold text-muted-foreground">
                {profile.avatarUrl ? (
                  <img
                    src={profile.avatarUrl}
                    alt={profile.name ? `${profile.name}'s avatar` : 'User avatar'}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span>{initials}</span>
                )}
              </div>
              </div>

            <div className="space-y-6">
              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
                  {error}
                </div>
              )}

              {isEditing ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Avatar URL
                    </label>
                    <input
                      type="url"
                      value={formData.avatarUrl}
                      onChange={(e) => setFormData({ ...formData, avatarUrl: e.target.value })}
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all bg-background text-foreground placeholder:text-muted-foreground"
                      placeholder="https://example.com/avatar.png"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Full Name
                    </label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all bg-background text-foreground placeholder:text-muted-foreground"
                      placeholder="Enter your full name"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Username
                    </label>
                    <input
                      type="text"
                      value={formData.username}
                      onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all bg-background text-foreground placeholder:text-muted-foreground"
                      placeholder="@username"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Bio
                    </label>
                    <textarea
                      value={formData.bio}
                      onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                      rows={4}
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all resize-none bg-background text-foreground placeholder:text-muted-foreground"
                      placeholder="Tell us about yourself..."
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Website
                    </label>
                    <input
                      type="url"
                      value={formData.website}
                      onChange={(e) => setFormData({ ...formData, website: e.target.value })}
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all bg-background text-foreground placeholder:text-muted-foreground"
                      placeholder="https://yourwebsite.com"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Location
                    </label>
                    <input
                      type="text"
                      value={formData.location}
                      onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all bg-background text-foreground placeholder:text-muted-foreground"
                      placeholder="City, Country"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="text-center">
                    <h1 className="text-3xl font-bold text-foreground mb-1">
                      {profile.name || 'No name set'}
                    </h1>
                    {profile.username && (
                      <p className="text-muted-foreground text-lg">@{profile.username}</p>
                    )}
                  </div>

                  {profile.bio && (
                    <div className="bg-muted rounded-xl p-4 border border-border/60">
                      <p className="text-foreground leading-relaxed whitespace-pre-wrap">
                        {profile.bio}
                      </p>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex items-center gap-3 text-muted-foreground">
                      <Mail className="w-5 h-5 text-blue-500 dark:text-blue-300" />
                      <span>{profile.email}</span>
                    </div>

                    {profile.location && (
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <MapPin className="w-5 h-5 text-blue-500 dark:text-blue-300" />
                        <span>{profile.location}</span>
                      </div>
                    )}

                    {profile.website && websiteHref && (
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <Globe className="w-5 h-5 text-blue-500 dark:text-blue-300" />
                        <a
                          href={websiteHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-blue-600 dark:hover:text-blue-300 transition-colors underline"
                        >
                          {profile.website.replace(/^https?:\/\//, '')}
                        </a>
                      </div>
                    )}

                    <div className="flex items-center gap-3 text-muted-foreground">
                      <Calendar className="w-5 h-5 text-blue-500 dark:text-blue-300" />
                      <span>Joined {formatDate(profile.createdAt)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
