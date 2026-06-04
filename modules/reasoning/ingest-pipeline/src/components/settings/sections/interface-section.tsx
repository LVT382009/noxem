import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import type { AppTheme } from "@/lib/theme"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
  onThemeChange?: (theme: AppTheme) => void
}

const UI_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
]

const THEMES = [
  { value: "light" as const, labelKey: "settings.sections.interface.themeLight" },
  { value: "dark" as const, labelKey: "settings.sections.interface.themeDark" },
  { value: "system" as const, labelKey: "settings.sections.interface.themeSystem" },
]

export function InterfaceSection({ draft, setDraft, onThemeChange }: Props) {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.interface.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.interface.description")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.interface.uiLanguage")}</Label>
        <div className="flex flex-wrap gap-2">
          {UI_LANGUAGES.map((l) => {
            const active = draft.uiLanguage === l.value
            return (
              <button
                key={l.value}
                type="button"
                onClick={() => setDraft("uiLanguage", l.value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {l.label}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.interface.uiLanguageHint")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.interface.theme")}</Label>
        <div className="flex flex-wrap gap-2">
          {THEMES.map((th) => {
            const active = draft.theme === th.value
            return (
              <button
                key={th.value}
                type="button"
                onClick={() => {
                  setDraft("theme", th.value)
                  onThemeChange?.(th.value)
                }}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {t(th.labelKey)}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.interface.themeHint")}
        </p>
      </div>
    </div>
  )
}
