import assert from "node:assert/strict";
import { test } from "node:test";
import { GUILD_ID, USER_ID } from "../../testing/helpers.js";
import { voiceStateEvent, type VoiceStateLike } from "./voice.js";

interface FakeVoiceOptions {
  channelId?: string | null;
  selfMute?: boolean;
  selfDeaf?: boolean;
  streaming?: boolean;
  selfVideo?: boolean;
}

function fakeVoice(options: FakeVoiceOptions = {}): VoiceStateLike {
  return {
    guildId: GUILD_ID,
    channelId: options.channelId === undefined ? "111111111111111111" : options.channelId,
    member: { id: USER_ID, user: { id: USER_ID, tag: "user#0001" } },
    selfMute: options.selfMute ?? false,
    selfDeaf: options.selfDeaf ?? false,
    streaming: options.streaming ?? false,
    selfVideo: options.selfVideo ?? false,
  };
}

test("voice join and move are distinct", () => {
  const joined = voiceStateEvent(
    fakeVoice({ channelId: null }),
    fakeVoice({ channelId: "111111111111111111" }),
    GUILD_ID,
  );
  assert.equal(joined?.type, "voice.join");
  const moved = voiceStateEvent(
    fakeVoice({ channelId: "111111111111111111" }),
    fakeVoice({ channelId: "222222222222222222" }),
    GUILD_ID,
  );
  assert.equal(moved?.type, "voice.move");
});

test("voice leave is distinct", () => {
  const left = voiceStateEvent(
    fakeVoice({ channelId: "111111111111111111" }),
    fakeVoice({ channelId: null }),
    GUILD_ID,
  );
  assert.equal(left?.type, "voice.leave");
});

test("voice state records mute, deafen, stream, and camera", () => {
  const event = voiceStateEvent(
    fakeVoice({
      channelId: "111111111111111111",
      selfMute: false,
      selfDeaf: false,
      streaming: false,
      selfVideo: false,
    }),
    fakeVoice({
      channelId: "111111111111111111",
      selfMute: true,
      selfDeaf: true,
      streaming: true,
      selfVideo: true,
    }),
    GUILD_ID,
  );
  assert.equal(event?.type, "voice.state");
  const fields = event?.fields?.map((entry) => entry.value).join(" ");
  assert.match(fields ?? "", /yes/);
});

test("unchanged voice state is ignored", () => {
  assert.equal(voiceStateEvent(fakeVoice(), fakeVoice(), GUILD_ID), null);
});
