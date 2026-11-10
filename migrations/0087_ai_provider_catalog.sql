-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE instance_integrations DROP CONSTRAINT IF EXISTS instance_integrations_provider_check;
ALTER TABLE instance_integrations ADD CONSTRAINT instance_integrations_provider_check
 CHECK (provider IN ('ringcentral','gmail','claude','erebine','openai','azure_openai','aws_bedrock','google_gemini','healthclinics'));
