#!/bin/bash
# Patches Baileys messages-send.js to use @lid server suffix for LID group participants.
# Baileys always encodes device JIDs as @s.whatsapp.net in groups (isLid is false for @g.us),
# but WA ignores prekey requests for @s.whatsapp.net when the user is a LID account,
# causing assertSessions to time out waiting for an ACK.
# This patch detects @lid participants from group metadata and uses the correct server suffix.
set -e
FILE="node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.js"
if ! grep -q '_serverForUser' "$FILE"; then
  node -e "
const fs = require('fs');
let src = fs.readFileSync('$FILE', 'utf8');
src = src.replace(
  \`                if (!participant) {
                    const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : [];
                    if (isStatus && statusJidList) {
                        participantsList.push(...statusJidList);
                    }
                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false);
                    devices.push(...additionalDevices);
                }
                const patched = await patchMessageBeforeSending(message, devices.map(d => (0, WABinary_1.jidEncode)(d.user, isLid ? 'lid' : 's.whatsapp.net', d.device)));
                const bytes = (0, Utils_1.encodeWAMessage)(patched);
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId,
                });
                const senderKeyJids = [];
                // ensure a connection is established with every device
                for (const { user, device } of devices) {
                    const jid = (0, WABinary_1.jidEncode)(user, isLid ? 'lid' : 's.whatsapp.net', device);\`,
  \`                const lidUsers = new Set();
                if (!participant) {
                    const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : [];
                    if (isStatus && statusJidList) {
                        participantsList.push(...statusJidList);
                    }
                    for (const pid of participantsList) {
                        if (pid.endsWith('@lid')) {
                            const d = (0, WABinary_1.jidDecode)(pid);
                            if (d) lidUsers.add(d.user);
                        }
                    }
                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false);
                    devices.push(...additionalDevices);
                }
                const _serverForUser = (u) => (isLid || lidUsers.has(u)) ? 'lid' : 's.whatsapp.net';
                const patched = await patchMessageBeforeSending(message, devices.map(d => (0, WABinary_1.jidEncode)(d.user, _serverForUser(d.user), d.device)));
                const bytes = (0, Utils_1.encodeWAMessage)(patched);
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId,
                });
                const senderKeyJids = [];
                // ensure a connection is established with every device
                for (const { user, device } of devices) {
                    const jid = (0, WABinary_1.jidEncode)(user, _serverForUser(user), device);\`
);
fs.writeFileSync('$FILE', src);
console.log('Baileys LID patch applied.');
"
else
  echo "Baileys LID patch already applied."
fi
