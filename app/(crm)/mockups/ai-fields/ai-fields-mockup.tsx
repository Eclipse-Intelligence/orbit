"use client";

import type { Viewer } from "@/components/crm/viewer";
import CompaniesMock from "./companies-mock";
import CompanyMock from "./company-mock";
import SettingsMock from "./settings-mock";
import type { Scene } from "./mock-data";

export default function AiFieldsMockup({ scene, viewer, workspace }: { scene: Scene; viewer: Viewer; workspace: { id: string; name: string } }) {
  if (scene === "settings") return <SettingsMock viewer={viewer} workspace={workspace} />;
  if (scene === "company") return <CompanyMock viewer={viewer} />;
  return <CompaniesMock scene={scene} viewer={viewer} />;
}
