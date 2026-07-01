// Poster preview generation — shared between editor.html and play.html.
//
// A "poster" is the frame you see behind the play-button overlay: the game
// simulated for a few seconds so the visitor sees something more interesting
// than a black canvas. It runs against a throwaway VM + fresh mediaStore so
// the real run (started when the user clicks play) isn't perturbed.
//
// Callers own their own screen instance and pass it in. Both hosts want the
// poster rendered on the same canvas the real VM will eventually use, so
// there's no benefit to owning the screen here.

globalThis.GMPoster = {
    // Parse `poster_seconds` from URL params.
    //   absent / non-numeric / negative → default 2s
    //   0                                → caller should skip poster entirely
    //   > 10                             → capped at 10s (protects against runaway URLs)
    //   decimals                         → rounded to 0.01s
    getPosterSeconds(params) {
        const raw = params.get('poster_seconds');
        if (raw === null) return 2;
        const parsed = parseFloat(raw);
        if (!isFinite(parsed) || parsed < 0) return 2;
        return Math.min(Math.round(parsed * 100) / 100, 10);
    },

    // Render a preview frame to `screen` by running a temp VM for
    // `posterSeconds` of simulated wallclock. `fileData` is the raw PRG
    // bytes — parsed fresh so we don't share mediaStore with the real run.
    //
    // Date.now is mocked to advance one frame per simulated frame so
    // `pause X.X` opcodes resolve without actually blocking. audioMuted
    // silences song-start opcodes even if an AudioContext already exists
    // from a previous run (relevant to editor.html; play.html's context
    // doesn't exist yet at poster time).
    async generatePoster({ screen, fileData, posterSeconds }) {
        if (!fileData || posterSeconds === 0) return;

        const realDateNow = Date.now.bind(Date);
        let simulatedNow = realDateNow();
        Date.now = () => simulatedNow;

        try {
            const programData = parseProgramData(fileData);
            const ast = buildAST(programData);
            const vm = new gmVM(screen);
            vm.loadProgram(ast, fileData, { audioMuted: true });
            vm.running = true;

            const totalFrames = Math.max(1, Math.round(posterSeconds * 60));
            const opsPerFrame = 50;
            const frameMs = 1000 / 60;
            // Mirror the real run loop: animation advances every other
            // frame so sprites land at ~30fps like on real hardware.
            let animToggle = false;
            for (let f = 0; f < totalFrames && vm.running; f++) {
                for (let i = 0; i < opsPerFrame && vm.running; i++) {
                    vm.step();
                }
                vm.updateSpritePositions();
                animToggle = !animToggle;
                vm.advanceSpriteAnimations(animToggle);
                simulatedNow += frameMs;
            }
            // Only the final frame matters — intermediate paints inside a
            // sync loop never composite anyway. advanceAnimation=false so
            // render doesn't nudge past what we already simulated.
            vm.render(false);
        } catch (e) {
            console.warn('poster generation failed:', e.message);
        } finally {
            Date.now = realDateNow;
        }
    }
};
