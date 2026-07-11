-- Cal.com integration: track the Cal booking uid so chat/voice can reschedule it
ALTER TABLE appointments ADD COLUMN cal_uid TEXT;
