import { AppearanceCard } from "@/components/settings/AppearanceCard";
import { GeneralSettingsCard } from "@/components/settings/GeneralSettingsCard";
import { ManageTagsCard } from "@/components/settings/ManageTagsCard";

export default function SettingsPage() {
  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold mb-1">Settings</h1>
        <p className="text-sm text-muted-foreground">Configure your account and app preferences.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <GeneralSettingsCard />
        </div>
        <div className="lg:col-span-1">
          <AppearanceCard />
        </div>
      </div>

      <div className="max-w-2xl">
        <ManageTagsCard />
      </div>
    </div>
  );
}
