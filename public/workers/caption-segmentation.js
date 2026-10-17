/**
 * Lightweight smart caption segmentation for the classic sherpa worker.
 *
 * Inspired by kiss-translator's rule/statistical sentence breaker:
 *   - prefer linguistic boundaries (punctuation, clause openers)
 *   - keep a minimum readable phrase
 *   - when forcing a hard length cap, cut at the best earlier boundary
 *   - allow early split on strong sentence punctuation even before max length
 *   - CJK-aware join/split without Latin spaces
 *   - translation-friendly: avoid dangling prepositions and weak mid-clause cuts
 */
(function installCaptionSegmentation(root) {
  // Clause openers / discourse markers — prefer breaking *before* these words.
  // Mirrors the connective list used by kiss-translator style breakers.
  var PAUSE_WORDS = new Set([
    'actually', 'also', 'although', 'and', 'anyway', 'as', 'because', 'but',
    'eventually', 'however', 'if', 'instead', 'meanwhile', 'moreover',
    'nevertheless', 'nonetheless', 'now', 'okay', 'or', 'otherwise', 'perhaps',
    'plus', 'right', 'since', 'so', 'still', 'then', 'therefore', 'though',
    'thus', 'unless', 'until', 'well', 'when', 'where', 'whereas', 'which',
    'while', 'who', 'yet',
  ]);

  // True clause openers that are usually safe early soft-breaks for live MT.
  // Keep weak mid-clause glue ("so", "and", "or", "as") out of this set — they
  // only guide hard-cap placement so we do not tear "for so very long" apart
  // just because the cue grew past preferred length.
  var STRONG_PAUSE_WORDS = new Set([
    'although', 'because', 'but', 'however', 'meanwhile', 'moreover',
    'nevertheless', 'nonetheless', 'otherwise', 'therefore', 'though',
    'whereas', 'yet',
  ]);

  // Never end a completed cue on these — leaves an incomplete PP/NP for MT.
  var DANGLING_ENDINGS = new Set([
    'a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from',
    'into', 'onto', 'upon', 'about', 'over', 'under', 'after', 'before',
    'between', 'through', 'during', 'without', 'within', 'across', 'against',
    'around', 'among', 'via', 'per', 'vs', 'versus',
    'my', 'your', 'his', 'her', 'its', 'our', 'their',
    'this', 'that', 'these', 'those',
  ]);

  function cleanWord(word) {
    return String(word || '')
      .toLocaleLowerCase()
      .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
  }

  function isMostlyCjk(text) {
    var visible = Array.from(String(text || '').replace(/\s/g, ''));
    if (!visible.length) return false;
    var cjk = (String(text || '').match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    return cjk / visible.length >= 0.5;
  }

  function joinCaptionText(prefix, current) {
    var left = String(prefix || '').trim();
    var right = String(current || '').trim();
    if (!left) return right;
    if (!right) return left;
    return isMostlyCjk(left + right) ? left + right : left + ' ' + right;
  }

  function isSoftBreakReason(reason, nextWord) {
    if (reason === 'sentence-punctuation' || reason === 'clause-punctuation') {
      return true;
    }
    // Soft early cuts only for strong discourse openers — weak glue words
    // ("so", "and", "as") wait for the hard cap so MT gets fuller clauses.
    if (reason === 'pause-word' && STRONG_PAUSE_WORDS.has(cleanWord(nextWord))) {
      return true;
    }
    return false;
  }

  /**
   * Score a candidate English split between words[boundary-1] and words[boundary].
   * Higher = better place to end the completed caption head.
   */
  function scoreEnglishBoundary(prev, next, boundary, preferredWords) {
    var prevClean = cleanWord(prev);
    var nextClean = cleanWord(next);
    var featureScore = 0;
    var reason = '';

    // Never close a cue after a dangling determiner / preposition
    // ("britain for | so very long" destroys the clause for translation).
    if (DANGLING_ENDINGS.has(prevClean)) {
      return null;
    }

    // Sentence-ending punctuation — strongest linguistic cue (kiss: +2.5 force).
    if (/[.?!…][\]})"']*$/u.test(prev)) {
      featureScore += 100;
      reason = 'sentence-punctuation';
    } else if (/[,;:][\]})"']*$/u.test(prev)) {
      featureScore += 70;
      reason = 'clause-punctuation';
    }

    // Prefer breaking *before* a discourse / clause opener.
    if (PAUSE_WORDS.has(nextClean)) {
      featureScore += STRONG_PAUSE_WORDS.has(nextClean) ? 62 : 40;
      if (!reason) reason = 'pause-word';
    }

    // Mixed-case sources often capitalise a new sentence. Ignore all-caps
    // broadcast captions (kiss: capitalBreakBonus, skip isAllCaps).
    if (/^[A-Z]/.test(next) && next !== next.toUpperCase() && next.length > 1) {
      featureScore += 22;
      if (!reason) reason = 'capitalization';
    }

    // Light preference for ending after a closing quote/paren.
    if (/["'”’)\]】」』]$/u.test(prev)) {
      featureScore += 12;
      if (!reason) reason = 'close-quote';
    }

    if (!featureScore) return null;

    // Soft preference toward the preferred line length (kiss-style).
    var score = featureScore - Math.abs(boundary - preferredWords) * 1.5;
    return { score: score, reason: reason };
  }

  function splitCjkCaption(text, maxChars, minChars, preferredChars) {
    var chars = Array.from(String(text || '').trim());
    if (!chars.length) return null;

    var lower = Math.max(1, Math.min(minChars, Math.max(maxChars - 1, 1)));
    var preferred = Math.min(Math.max(preferredChars, lower), Math.max(maxChars, lower));

    // Early split: strong sentence punctuation past minChars, even before max.
    var earlyBest = -1;
    var earlyScore = -Infinity;
    var earlyReason = 'punctuation';
    var scanUpper = Math.min(chars.length, Math.max(maxChars * 2, preferred + 8));
    for (var i = lower; i <= scanUpper && i <= chars.length; i++) {
      var ch = chars[i - 1] || '';
      var f = 0;
      var r = '';
      if (/[。！？!?…]/u.test(ch)) {
        f = 100;
        r = 'sentence-punctuation';
      } else if (/[，、；;：:」』》】）)]/u.test(ch)) {
        f = 65;
        r = 'clause-punctuation';
      }
      if (!f) continue;
      // Prefer early sentence ends once we have a readable phrase.
      var s = f - Math.abs(i - preferred) * 1.2;
      if (s > earlyScore) {
        earlyScore = s;
        earlyBest = i;
        earlyReason = r;
      }
    }

    // Strong sentence end mid-string → cut early (kiss early force). Skip if
    // the only sentence end is the final character (nothing left to carry).
    if (
      earlyBest > 0
      && earlyReason === 'sentence-punctuation'
      && earlyBest >= lower
      && earlyBest < chars.length
    ) {
      return {
        head: chars.slice(0, earlyBest).join('').trim(),
        tail: chars.slice(earlyBest).join('').trim(),
        boundary: earlyBest,
        reason: earlyReason,
      };
    }

    if (!maxChars || chars.length < maxChars) {
      // Soft clause break past preferred length (readable line without hard cap).
      // Prefer the earliest clause punctuation that still leaves a non-empty tail.
      if (
        earlyBest > 0
        && earlyBest >= preferred
        && earlyBest < chars.length
        && chars.length >= preferred + 4
      ) {
        return {
          head: chars.slice(0, earlyBest).join('').trim(),
          tail: chars.slice(earlyBest).join('').trim(),
          boundary: earlyBest,
          reason: earlyReason,
        };
      }
      return null;
    }

    var upper = Math.min(maxChars, chars.length);
    var bestBoundary = -1;
    var bestScore = -Infinity;
    var bestReason = 'hard-limit';

    for (var boundary = lower; boundary <= upper; boundary++) {
      var prev = chars[boundary - 1] || '';
      var score = -Math.abs(boundary - preferred);
      var featureScore = 0;
      var reason = '';
      if (/[。！？.!?…]/u.test(prev)) {
        featureScore += 100;
        reason = 'sentence-punctuation';
      } else if (/[，、；;：:」』》】）)]/u.test(prev)) {
        featureScore += 65;
        reason = 'clause-punctuation';
      }
      if (!featureScore) continue;
      score += featureScore;
      if (score > bestScore) {
        bestScore = score;
        bestBoundary = boundary;
        bestReason = reason;
      }
    }

    // Hard cap: prefer best linguistic cut inside the window (kiss forceBreak).
    var splitAt = bestBoundary > 0 ? bestBoundary : upper;
    return {
      head: chars.slice(0, splitAt).join('').trim(),
      tail: chars.slice(splitAt).join('').trim(),
      boundary: splitAt,
      reason: bestBoundary > 0 ? bestReason : 'hard-limit',
    };
  }

  /**
   * Return the best closed caption phrase plus the uncommitted tail.
   * `tail` must be carried into the next recognizer stream after reset.
   */
  function findSmartCaptionSplit(text, options) {
    options = options || {};
    var maxWords = Math.max(4, Number(options.maxWords) || 16);
    var minWords = Math.max(2, Math.min(Number(options.minWords) || 5, maxWords - 1));
    var preferredWords = Math.min(
      Math.max(Number(options.preferredWords) || 12, minWords),
      maxWords
    );
    var maxChars = Math.max(8, Number(options.maxChars) || 42);
    // Force-punctuation early split thresholds (kiss forcePunctuationMinWords ≈ 6).
    var forcePunctuationMinWords = Math.max(
      minWords,
      Number(options.forcePunctuationMinWords) || 6
    );

    if (isMostlyCjk(text)) {
      return splitCjkCaption(
        text,
        maxChars,
        Number(options.minChars) || 12,
        Number(options.preferredChars) || 28
      );
    }

    var words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (words.length < minWords) return null;

    var overCap = words.length >= maxWords;
    var scanEnd = overCap ? Math.min(maxWords, words.length) : words.length;

    var bestBoundary = -1;
    var bestScore = -Infinity;
    var bestReason = 'hard-limit';
    var bestNext = '';
    var strongSentenceBoundary = -1;

    // Leave at least one look-ahead word so clause openers can be recognized.
    for (var boundary = minWords; boundary < scanEnd; boundary++) {
      var prev = words[boundary - 1] || '';
      var next = words[boundary] || '';
      var ranked = scoreEnglishBoundary(prev, next, boundary, preferredWords);
      if (!ranked) continue;

      if (ranked.reason === 'sentence-punctuation' && boundary >= forcePunctuationMinWords) {
        if (strongSentenceBoundary < 0 || ranked.score > bestScore) {
          strongSentenceBoundary = boundary;
        }
      }

      if (ranked.score > bestScore) {
        bestScore = ranked.score;
        bestBoundary = boundary;
        bestReason = ranked.reason;
        bestNext = next;
      }
    }

    // Early split on a clear sentence end (kiss mandatory punctuation break),
    // even when we have not yet hit maxWords — produces shorter, more
    // subtitle-like cues instead of one long run-on caption.
    if (strongSentenceBoundary > 0 && !overCap) {
      // Only fire early once we are past preferred length, or the remaining
      // tail is long enough to stand alone as the next cue.
      var tailWords = words.length - strongSentenceBoundary;
      if (strongSentenceBoundary >= preferredWords || tailWords >= minWords) {
        return {
          head: words.slice(0, strongSentenceBoundary).join(' ').trim(),
          tail: words.slice(strongSentenceBoundary).join(' ').trim(),
          boundary: strongSentenceBoundary,
          reason: 'sentence-punctuation',
        };
      }
    }

    // Soft clause break past preferred length (readable line without hard cap).
    // Only strong linguistic cues — weak "so/and/as" wait for the hard cap so
    // streaming MT receives fuller clauses without much extra latency.
    // Strong discourse openers ("however", "but") may fire a bit earlier than
    // preferredWords once we have a readable head, so turns like
    // "...today | however now..." still land on a natural boundary.
    var softMinBoundary = isSoftBreakReason(bestReason, bestNext)
      && bestReason === 'pause-word'
      ? Math.max(minWords, Math.floor(preferredWords * 0.7))
      : preferredWords;
    // Strong pause soft-cuts tolerate a slightly lower score because they often
    // fire a few words before preferredWords (distance penalty ~3–6 points).
    var softScoreFloor = bestReason === 'pause-word' ? 54 : 60;
    if (
      !overCap
      && bestBoundary > 0
      && bestScore >= softScoreFloor
      && bestBoundary >= softMinBoundary
      && words.length >= softMinBoundary + 3
      && isSoftBreakReason(bestReason, bestNext)
    ) {
      return {
        head: words.slice(0, bestBoundary).join(' ').trim(),
        tail: words.slice(bestBoundary).join(' ').trim(),
        boundary: bestBoundary,
        reason: bestReason,
      };
    }

    if (!overCap) return null;

    // Hard length cap — cut at the best linguistic boundary inside the window
    // (kiss forceBreak uses bestBreakSinceStart rather than the far edge).
    // If the only candidate still dangles (all scored null), walk back from
    // the hard edge past dangling endings before forcing a cut.
    var upper = Math.min(maxWords, words.length);
    var splitAt = bestBoundary > 0 ? bestBoundary : upper;
    if (bestBoundary <= 0) {
      while (splitAt > minWords && DANGLING_ENDINGS.has(cleanWord(words[splitAt - 1] || ''))) {
        splitAt -= 1;
      }
    }
    return {
      head: words.slice(0, splitAt).join(' ').trim(),
      tail: words.slice(splitAt).join(' ').trim(),
      boundary: splitAt,
      reason: bestBoundary > 0 ? bestReason : 'hard-limit',
    };
  }

  root.CaptionSegmentation = {
    findSmartCaptionSplit: findSmartCaptionSplit,
    isMostlyCjk: isMostlyCjk,
    joinCaptionText: joinCaptionText,
  };
})(typeof self !== 'undefined' ? self : globalThis);
