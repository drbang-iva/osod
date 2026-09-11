# AWS End User Messaging SMS setup

ODOS uses AWS End User Messaging SMS for outbound text delivery and a standard SNS topic feeding a
standard SQS queue for inbound delivery. The MCP service long-polls SQS; it does not expose an AWS
webhook or perform SNS signature verification. Topic identity is checked against the configured ARN,
and a queue message is deleted only after downstream persistence and the shared suppression update
both succeed.

## Runtime configuration

Configure one scalar SMS provider and keep every AWS resource in the phone number's account and
region:

```dotenv
ODOS_COMMS_SMS_PROVIDER=aws
AWS_SMS_REGION=us-east-1
AWS_SMS_ORIGINATION_IDENTITY=arn:aws:sms-voice:REGION:ACCOUNT_ID:phone-number/PHONE_NUMBER_ID
AWS_SMS_SQS_QUEUE_URL=https://sqs.REGION.amazonaws.com/ACCOUNT_ID/QUEUE_NAME
AWS_SMS_SNS_TOPIC_ARN=arn:aws:sns:REGION:ACCOUNT_ID:TOPIC_NAME
```

The runtime identity needs only `sms-voice:SendTextMessage`, `sqs:ReceiveMessage`,
`sqs:DeleteMessage`, and `sqs:GetQueueAttributes` on the named resources. Do not grant SNS
administration to the runtime.

## Manual infrastructure steps

There is no AWS infrastructure-as-code substrate in this repository. An operator must perform these
steps in the practice-owned AWS account before enabling the receiver:

1. Create a **standard** SNS topic and **standard** SQS queue in the phone number's region. FIFO is
   not supported for this AWS two-way SMS path.
2. Add an SNS topic policy allowing principal `sms-voice.amazonaws.com` to call `sns:Publish` on
   only that topic. Include `aws:SourceAccount` for the practice account and `aws:SourceArn` for the
   phone-number ARN.
3. Add an SQS queue policy allowing `sqs:SendMessage` from only the chosen SNS topic ARN, using an
   `aws:SourceArn` condition.
4. Subscribe the queue ARN to the topic, leaving raw message delivery disabled so ODOS receives the
   SNS envelope and can verify `TopicArn`:

   ```sh
   aws sns subscribe \
     --region REGION \
     --topic-arn TOPIC_ARN \
     --protocol sqs \
     --notification-endpoint QUEUE_ARN
   ```

5. After this code is deployed and the queue consumer is running, enable self-managed opt-outs and
   two-way SMS on the phone number:

   ```sh
   aws pinpoint-sms-voice-v2 update-phone-number \
     --region REGION \
     --phone-number-id PHONE_NUMBER_ID \
     --self-managed-opt-outs-enabled \
     --two-way-enabled \
     --two-way-channel-arn TOPIC_ARN
   ```

6. Confirm the resulting state without changing it:

   ```sh
   aws pinpoint-sms-voice-v2 describe-phone-numbers \
     --region REGION \
     --phone-number-ids PHONE_NUMBER_ID \
     --query 'PhoneNumbers[0].{Status:Status,TwoWayEnabled:TwoWayEnabled,TwoWayChannelArn:TwoWayChannelArn,SelfManagedOptOutsEnabled:SelfManagedOptOutsEnabled}'
   ```

Do not enable two-way delivery before the queue policy, subscription, deployed consumer, and ODOS
suppression tests are all in place. With self-managed opt-outs enabled, ODOS owns STOP/START state;
AWS still routes those inbound keywords through the configured topic.

## Synthetic verification

Use only a synthetic local Patient. Send a STOP-equivalent inbound SNS notification through the
test queue, confirm one inbound `Communication` is persisted, then confirm a subsequent outbound
attempt returns `patient-opt-out` without invoking AWS. Repeat with a signed Twilio inbound
STOP-equivalent message when Twilio is the selected SMS provider. A local or mocked test is not proof
that production access, carrier registration, two-way routing, or a real handset exchange works.

## Communication preferences

The server applies patient suppression before the purpose/channel preference matrix, then frequency caps and quiet hours. An explicit preference cannot undo STOP or an email opt-out. Accepted START restores the four nonmarketing text preferences in the same Patient update. Marketing SMS retains the legacy recorded-consent requirement; marketing email defaults ON while email opt-outs still block. A deliberate staff transactional education email can override a withheld Education × Email preference and records that cell ON after sending; a failed preference write reports `preferenceUpdate: "failed"` without reversing the sent result. Preference and consent-evidence routes use versioned Patient transactions; the evidence-gap report tracks missing evidence without gating sends. Call and mail preferences are recorded but have no automated sender. The preference screens are a separate delivery slice.
