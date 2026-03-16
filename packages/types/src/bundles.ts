export interface BundleListItem {
  id: string;
  name: string;
  description?: string | null;
  starred: boolean;
  itemCount: number;
  coverMediaId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BundleMediaItem {
  mediaId: string;
  order: number;
  addedAt: string;
  title: string;
  mimeType: string;
  thumbState: string;
  thumbnailKey?: string | null;
}

export interface BundleDetail extends Omit<BundleListItem, 'coverMediaId'> {
  coverMediaId?: string | null;
  items: BundleMediaItem[];
}

export interface BundlesListResponse {
  bundles: BundleListItem[];
}

export interface CreateBundleInput {
  name: string;
  description?: string;
}
