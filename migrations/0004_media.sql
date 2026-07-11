-- Store the source URL + type of any uploaded media so the dashboard can display it live
ALTER TABLE messages ADD COLUMN media_url TEXT;
ALTER TABLE messages ADD COLUMN media_type TEXT;
