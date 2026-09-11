export interface CommsCapabilities {
  sms: boolean;
  calls: boolean;
  email: boolean;
  contacts: boolean;
  conversations: boolean;
  reviews: boolean;
}

export interface SuppressionContext {
  staffEducationOverride?: true;
  consentClass?: "transactional" | "marketing";
  requiresMarketingConsent?: boolean;
  frequencyCapDays?: number;
  quietHoursExemption?: "staff-initiated-chart-education";
}

export interface SendEmailRequest {
  patientReference: string;
  toAddress?: string;
  subject: string;
  body: string;
  templateId?: string;
  campaignType: string;
  campaignId?: string;
  messageId?: string;
  suppression: SuppressionContext;
}

export interface SendSmsRequest {
  patientReference: string;
  toNumber?: string;
  body: string;
  campaignType: string;
  campaignId?: string;
  messageId?: string;
  suppression: SuppressionContext;
}

export type SendResult =
  | {
      outcome: "sent";
      providerMessageId: string;
      providerThreadId?: string;
    }
  | {
      outcome: "suppressed";
      reason: "patient-opt-out" | "preference-withheld" | "frequency-cap";
    }
  | {
      outcome: "rescheduled";
      reason: "quiet-hours";
      rescheduledAt: string;
    };

export interface ConversationSummary {
  id: string;
  provider?: string;
  patientReference?: string;
  updatedAt?: string;
  messageCount?: number;
  preview?: string;
  channel?: string;
  unreadCount?: number;
  displayName?: string;
  phone?: string;
  email?: string;
  messages: ConversationMessage[];
}

export interface ConversationMessage {
  id: string;
  direction: "inbound" | "outbound" | "unknown";
  status: string;
  occurredAt?: string;
  from?: string;
  to?: string;
  body?: string;
}

export interface ConversationMessageReadRequest {
  includeContent?: boolean;
}

export interface ConversationListRequest {
  patientReference?: string;
  limit?: number;
  includeContent?: boolean;
}

export interface CallRequest {
  patientReference: string;
  toNumber?: string;
}

export interface CallListRequest {
  limit?: number;
}

export interface CallDetail {
  id: string;
  from: string;
  to: string;
  status: string;
  direction: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
}

export interface CallRecording {
  id: string;
  callId: string;
  status: string;
  durationSeconds?: number;
  contentType: string;
  audio: Uint8Array;
}

export interface CallTranscription {
  id: string;
  recordingId?: string;
  status: string;
  text?: string;
}

export interface ContactSearch {
  query: string;
}

export interface ContactRecord {
  id?: string;
  patientReference?: string;
  email?: string;
  phone?: string;
}

/**
 * Vendor-neutral communications seam. Methods outside the declared capability surface are
 * optional so partial providers stay honest while future adapters share this stable contract.
 */
export interface CommsProvider {
  preflightSuppression?(request: SendEmailRequest | SendSmsRequest, channel: "email" | "sms"): Promise<Exclude<SendResult, { outcome: "sent" }> | undefined>;
  readonly name: string;
  readonly messageIdentifierSystem?: string;
  readonly capabilities: Readonly<CommsCapabilities>;
  sendEmail?(request: SendEmailRequest): Promise<SendResult>;
  sendSms?(request: SendSmsRequest): Promise<SendResult>;
  listConversations?(request?: ConversationListRequest): Promise<ConversationSummary[]>;
  getConversationMessages?(
    conversationId: string,
    request?: ConversationMessageReadRequest,
  ): Promise<ConversationMessage[]>;
  initiateCall?(request: CallRequest): Promise<{ callId: string }>;
  getCall?(callId: string): Promise<CallDetail>;
  listCalls?(request?: CallListRequest): Promise<CallDetail[]>;
  fetchRecording?(recordingId: string): Promise<CallRecording>;
  fetchTranscription?(transcriptionId: string): Promise<CallTranscription>;
  searchContacts?(request: ContactSearch): Promise<ContactRecord[]>;
  upsertContact?(contact: ContactRecord): Promise<ContactRecord>;
}
