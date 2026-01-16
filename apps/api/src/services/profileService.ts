import { normalizeNullable } from "../lib/strings/normalize.js";
import { ProfileRepository } from "../repositories/profileRepository.js";

export type ProfilePatch = {
  name?: string | null;
  username?: string | null;
  bio?: string | null;
  website?: string | null;
  location?: string | null;
  avatarUrl?: string | null;
};

export class ProfileService {
  constructor(private readonly repo: ProfileRepository) {}

  async getProfile (userId: string) {
    return this.repo.getProfile(userId);
  }

  async updateProfile (userId: string, patch: ProfilePatch) {
    const data: ProfilePatch = {};
    if (Object.prototype.hasOwnProperty.call(patch, "name")) data.name = normalizeNullable(patch.name ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "username")) data.username = normalizeNullable(patch.username ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "bio")) data.bio = normalizeNullable(patch.bio ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "website")) data.website = normalizeNullable(patch.website ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "location")) data.location = normalizeNullable(patch.location ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, "avatarUrl")) data.avatarUrl = normalizeNullable(patch.avatarUrl ?? null);

    if (Object.keys(data).length === 0) {
      return this.repo.getProfile(userId);
    }

    return this.repo.updateProfile(userId, data);
  }
}
