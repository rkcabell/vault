/**
 * Reads and edits the account details shown on a user's profile page.
 */
import { normalizeNullable } from "../lib/strings/normalize.js";
import { type ProfileRepository } from "../repositories/profileRepository.js";

/** The profile fields a request may change. A field left out is not touched; a field set to null is cleared. */
export type ProfilePatch = {
  name?: string | null;
  username?: string | null;
  bio?: string | null;
  website?: string | null;
  location?: string | null;
  avatarUrl?: string | null;
};

/** Applies profile edits, deciding which fields a request actually meant to change. */
export class ProfileService {
  constructor(private readonly repo: ProfileRepository) {}

  async getProfile (userId: string) {
    return this.repo.getProfile(userId);
  }

  /**
   * Changes the profile fields named in `patch` and returns the result.
   *
   * A field is only written when `patch` names it, which is how clearing a
   * field is told apart from leaving it alone. Text that is blank or only
   * spaces is stored as null. A patch naming no fields reads the profile back
   * unchanged.
   */
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
