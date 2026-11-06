import checkSvg from "../../../public/assets/images/assistant/check.svg";
import chevronSvg from "../../../public/assets/images/_common/chevron-down.svg";
import clipboardSvg from "../../../public/assets/images/companies/sidebar/clipboard.svg";
import externalSvg from "../../../public/assets/images/booking/external.svg";
import logoSvg from "../../../public/assets/images/_common/logo.svg";
import mailSvg from "../../../public/assets/images/companies/sidebar/mail.svg";
import moreSvg from "../../../public/assets/images/_common/more.svg";
import noteSvg from "../../../public/assets/images/crm/activity/note.svg";
import refreshSvg from "../../../public/assets/images/mail/refresh.svg";
import usersSvg from "../../../public/assets/images/companies/sidebar/users.svg";
import { h } from "./dom";

export const ICONS = {
  check: checkSvg as string,
  chevron: chevronSvg as string,
  clipboard: clipboardSvg as string,
  external: externalSvg as string,
  logo: logoSvg as string,
  mail: mailSvg as string,
  more: moreSvg as string,
  note: noteSvg as string,
  refresh: refreshSvg as string,
  users: usersSvg as string,
};

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, className = "icon") {
  return h("span", { class: className, "aria-hidden": "true", html: ICONS[name] });
}
