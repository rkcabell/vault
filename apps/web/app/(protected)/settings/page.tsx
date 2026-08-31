import { AppearanceCard } from "@/components/settings/AppearanceCard";
import { GeneralSettingsCard } from "@/components/settings/GeneralSettingsCard";
import { ManageTagsCard } from "@/components/settings/ManageTagsCard";
import { StorageSettingsCard } from "@/components/settings/StorageSettingsCard";
import { IndexingSettingsCard } from "@/components/settings/IndexingSettingsCard";
import { ExploreSettingsCard } from "@/components/settings/ExploreSettingsCard";
import { DuplicatesCard } from "@/components/settings/DuplicatesCard";
import { MetadataBackupCard } from "@/components/settings/MetadataBackupCard";
import { SettingsChapters, SettingsSection } from "@/components/settings/SettingsChapters";

export default function SettingsPage() {
  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold mb-1">Settings</h1>
        <p className="text-sm text-muted-foreground">Configure your account and app preferences.</p>
      </div>

      <SettingsChapters />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <SettingsSection id="general" className="lg:col-span-2">
          <GeneralSettingsCard />
        </SettingsSection>
        <div className="lg:col-span-1">
          <AppearanceCard />
        </div>
      </div>

      <SettingsSection id="storage">
        <StorageSettingsCard />
      </SettingsSection>

      <SettingsSection id="index">
        <IndexingSettingsCard />
      </SettingsSection>

      <SettingsSection id="metadata">
        <MetadataBackupCard />
      </SettingsSection>

      <SettingsSection id="duplicates">
        <DuplicatesCard />
      </SettingsSection>

      <SettingsSection id="explore">
        <ExploreSettingsCard />
      </SettingsSection>

      <SettingsSection id="tags" className="max-w-2xl">
        <ManageTagsCard />
      </SettingsSection>
    </div>
  );
}
