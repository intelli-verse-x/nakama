import { hash } from "./lib.mjs";

function common(overrides) {
  return {
    provider: "fixture",
    robots_allowed: true,
    auth_gated: false,
    paywalled: false,
    private_content: false,
    rights_ok: true,
    mime_valid: true,
    size_valid: true,
    redirect_valid: true,
    media_health_ok: true,
    content_safety_ok: true,
    age_gate_ok: true,
    contains_pii: false,
    deterministic_verified: true,
    answer_supported_by_citation: true,
    experience_approved: true,
    published_at: "2024-01-01",
    difficulty: 2,
    ...overrides,
  };
}

export function fixtureCandidates() {
  const out = [];
  for (let i = 1; i <= 16; i++) {
    const media = `https://commons.wikimedia.org/wiki/Special:Redirect/file/SeedQ_fixture_${i}.jpg`;
    out.push(common({
      candidate_id: `fixture-image-${i}`,
      media_type: "image",
      canonical_url: `https://commons.wikimedia.org/wiki/File:SeedQ_fixture_${i}.jpg`,
      source_url: `https://commons.wikimedia.org/wiki/File:SeedQ_fixture_${i}.jpg`,
      media_url: media,
      media_mime: "image/jpeg",
      title: `Public-domain archive specimen ${i}`,
      caption: `Numbered public-domain fixture specimen ${i}`,
      alt_text: `Numbered public-domain fixture specimen ${i}`,
      creator: "SeedQ fixture author",
      license: "public_domain",
      license_url: "https://creativecommons.org/publicdomain/mark/1.0/",
      citation: `Fixture catalog record ${i}, public-domain mark`,
      question: `Which catalog label matches numbered archive item ${i}?`,
      options: [`Archive specimen ${i}`, `Archive sample ${i + 20}`, `Archive plate ${i + 40}`, `Archive record ${i + 60}`],
      correct_index: 0,
      explanation: `The cited fixture catalog identifies item ${i} as Archive specimen ${i}.`,
      asset_hash: hash(media),
    }));
  }
  for (let i = 1; i <= 16; i++) {
    const id = `seedqfixture${String(i).padStart(2, "0")}`;
    const embed = `https://www.youtube.com/embed/${id}?start=${i * 5}`;
    out.push(common({
      candidate_id: `fixture-video-${i}`,
      media_type: "video",
      canonical_url: `https://www.youtube.com/watch?v=${id}`,
      source_url: `https://www.youtube.com/watch?v=${id}`,
      media_url: embed,
      embed_url: embed,
      thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      media_mime: "video/youtube",
      title: `Fixture explainer segment ${i}`,
      caption: `Metadata-only embeddable fixture video ${i}`,
      alt_text: `Thumbnail for fixture explainer segment ${i}`,
      creator: "SeedQ fixture channel",
      license: "api_tos_embed",
      license_url: "https://www.youtube.com/static?template=terms",
      citation: `Fixture transcript segment ${i}, 00:${String(i * 5).padStart(2, "0")}-00:${String(i * 5 + 4).padStart(2, "0")}`,
      transcript_url: `https://www.youtube.com/watch?v=${id}`,
      cited_segment: `The segment explicitly states that marker ${i} is the verified answer.`,
      timecode_seconds: i * 5,
      embeddable: true,
      question: `According to cited fixture segment ${i}, which marker is identified?`,
      options: [`Verified marker ${i}`, `Alternate marker ${i + 20}`, `Control marker ${i + 40}`, `Placeholder marker ${i + 60}`],
      correct_index: 0,
      explanation: `The cited segment explicitly identifies Verified marker ${i}.`,
      asset_hash: hash(`youtube:${id}`),
    }));
  }
  return out;
}
