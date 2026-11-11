// SPDX-License-Identifier: AGPL-3.0-only
//! Presentation-only identity for a managed EHR instance.
//!
//! Connect stores and serves approved logo bytes. The EHR accepts only the
//! configured Connect origin and its immutable branding-asset route, so a
//! clinic name cannot turn the login page into an arbitrary HTML or tracking
//! surface.

use url::Url;
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InstanceBranding {
    pub display_name: String,
    pub logo_url: Option<String>,
    pub managed: bool,
}

impl Default for InstanceBranding {
    fn default() -> Self {
        Self {
            display_name: "Self-hosted workspace".into(),
            logo_url: None,
            managed: false,
        }
    }
}

pub(crate) fn valid_display_name(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value.chars().count() <= 120 && !value.chars().any(char::is_control)
}

pub(crate) fn valid_logo_url(value: &str, connect_origin: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    let Ok(connect) = Url::parse(connect_origin) else {
        return false;
    };
    if url.origin() != connect.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let Some(asset) = url
        .path()
        .strip_prefix("/api/v1/managed-ehr/branding/assets/")
    else {
        return false;
    };
    !asset.contains('/') && Uuid::parse_str(asset).is_ok()
}

impl InstanceBranding {
    pub(crate) fn from_env() -> Self {
        let Ok(display_name) = std::env::var("ENGINE_BRAND_DISPLAY_NAME") else {
            return Self::default();
        };
        if !valid_display_name(&display_name) {
            return Self::default();
        }
        let logo_url = std::env::var("ENGINE_BRAND_LOGO_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .filter(|value| {
                crate::connect_onboarding::cloud_origin()
                    .is_ok_and(|origin| valid_logo_url(value, &origin))
            });
        Self {
            display_name: display_name.trim().to_owned(),
            logo_url,
            managed: true,
        }
    }

    fn escape(value: &str) -> String {
        let mut escaped = String::with_capacity(value.len());
        for character in value.chars() {
            match character {
                '&' => escaped.push_str("&amp;"),
                '<' => escaped.push_str("&lt;"),
                '>' => escaped.push_str("&gt;"),
                '"' => escaped.push_str("&quot;"),
                '\'' => escaped.push_str("&#39;"),
                _ => escaped.push(character),
            }
        }
        escaped
    }

    pub(crate) fn login_html(&self) -> String {
        if !self.managed {
            return String::new();
        }
        let name = Self::escape(&self.display_name);
        let mark = self.logo_url.as_deref().map_or_else(
            || "<span class=\"clinic-brand-fallback\" aria-hidden=\"true\">S</span>".into(),
            |url| {
                format!(
                    "<img src=\"{}\" alt=\"\" width=\"160\" height=\"64\">",
                    Self::escape(url)
                )
            },
        );
        format!(
            "<div class=\"clinic-login-brand\">{mark}<div><span>Managed clinical workspace</span><strong>{name}</strong></div></div>"
        )
    }

    pub(crate) fn sidebar_html(&self) -> String {
        let name = Self::escape(&self.display_name);
        let mark = self.logo_url.as_deref().map_or_else(
            || {
                let initial = self
                    .display_name
                    .chars()
                    .find(|character| character.is_alphanumeric())
                    .unwrap_or('S');
                format!(
                    "<span class=\"practice-identity-mark\" aria-hidden=\"true\">{}</span>",
                    Self::escape(&initial.to_string())
                )
            },
            |url| {
                format!(
                    "<span class=\"practice-identity-mark practice-identity-logo\"><img src=\"{}\" alt=\"\"></span>",
                    Self::escape(url)
                )
            },
        );
        let context = if self.managed {
            "Managed by SunCharts Connect"
        } else {
            "SunCharts EHR"
        };
        format!(
            "<div class=\"practice-identity\">{mark}<div><strong>{name}</strong><span>{context} · Build <span class=\"build-version\">__SUN_CHARTS_BUILD__</span></span></div></div>"
        )
    }

    pub(crate) fn content_security_policy(&self) -> String {
        const PREFIX: &str = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:";
        const SUFFIX: &str = "; worker-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";
        let source = self.logo_url.as_deref().and_then(|value| {
            let connect = crate::connect_onboarding::cloud_origin().ok()?;
            if valid_logo_url(value, &connect) {
                Some(Url::parse(&connect).ok()?.origin().ascii_serialization())
            } else {
                None
            }
        });
        source.map_or_else(
            || format!("{PREFIX}{SUFFIX}"),
            |origin| format!("{PREFIX} {origin}{SUFFIX}"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logo_must_be_an_immutable_asset_on_the_configured_connect_origin() {
        let asset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        assert!(valid_logo_url(
            &format!("https://connect.suncharts.app/api/v1/managed-ehr/branding/assets/{asset}"),
            "https://connect.suncharts.app"
        ));
        assert!(!valid_logo_url(
            &format!("https://example.test/api/v1/managed-ehr/branding/assets/{asset}"),
            "https://connect.suncharts.app"
        ));
        assert!(!valid_logo_url(
            "https://connect.suncharts.app/api/v1/managed-ehr/branding/assets/not-a-uuid",
            "https://connect.suncharts.app"
        ));
    }

    #[test]
    fn rendered_branding_escapes_customer_text() {
        let branding = InstanceBranding {
            display_name: "Synthetic <Clinic> & Friends".into(),
            logo_url: None,
            managed: true,
        };
        let html = branding.login_html();
        assert!(html.contains("Synthetic &lt;Clinic&gt; &amp; Friends"));
        assert!(!html.contains("Synthetic <Clinic>"));
    }

    #[test]
    fn arbitrary_logo_origin_never_enters_content_security_policy() {
        let branding = InstanceBranding {
            display_name: "Synthetic Clinic".into(),
            logo_url: Some("https://tracker.example/pixel.png".into()),
            managed: true,
        };
        let policy = branding.content_security_policy();
        assert!(!policy.contains("tracker.example"));
        assert_eq!(policy.matches("https://").count(), 0);

        let approved = InstanceBranding {
            display_name: "Synthetic Clinic".into(),
            logo_url: Some("https://connect.suncharts.app/api/v1/managed-ehr/branding/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into()),
            managed: true,
        };
        assert!(approved
            .content_security_policy()
            .contains("img-src 'self' data: https://connect.suncharts.app;"));
    }
}
