# Orchestral Anechoic Stereo Mixer

A web-based audio mixer that simulates the physics of sound propagation in a concert hall environment. Load anechoic (echo-free) symphony orchestra recordings and position instruments on a virtual stage to create realistic stereo mixes.

## Live Demo

**[https://antorsae.github.io/web-mixer/](https://antorsae.github.io/web-mixer/)**

## Features

### Physics-Based Audio Simulation

The mixer implements several acoustic phenomena to create realistic spatial audio:

- **Interaural Time Difference (ITD)**: Sound arrives at the closer ear before the farther ear, creating natural localization cues. The delay is calculated based on the head model and sound source position.

- **Distance-Based Amplitude Decay**: Sound intensity follows the inverse-square law (1/r), where instruments farther from the microphones are naturally quieter.

- **Air Absorption**: High frequencies are attenuated more over distance, simulating the natural filtering effect of air. This creates more realistic depth perception for distant instruments.

- **Ground Reflection** (optional): Simulates sound bouncing off the stage floor, adding subtle comb-filtering effects that contribute to the sense of space.

### Dual Virtual Microphone System

Two virtual microphones (L and R) capture the orchestra from the audience position:

- **Adjustable Separation**: Drag the microphone icons or use the slider to adjust the stereo width (0.5m to 6m separation)
- **Spaced Pair Configuration**: Creates natural stereo imaging with both time and amplitude differences
- **Visual Feedback**: Microphone positions are displayed on the stage canvas with real-time separation readout

### Instrument Directivity Simulation

When multiple microphone positions are available for an instrument (e.g., front mic, top mic, bell mic), the mixer can simulate directional characteristics:

- Instruments facing the audience project more high-frequency content forward
- Rear-facing instruments sound more muffled
- This is achieved by blending between different mic recordings based on the instrument's orientation

### Stage Visualization

The interactive stage canvas provides intuitive control:

- **Drag to Position**: Move instrument circles to reposition them on the stage
- **Circle Size = Gain**: The radius of each circle represents the instrument's gain level
- **Edge Drag to Resize**: Drag the edge of a circle to adjust gain
- **Mute/Solo Buttons**: Quick M/S toggles on each instrument circle
- **Color-Coded Families**: Strings (brown), Woodwinds (olive), Brass (gold), Percussion (blue), Keyboard (purple), Voice (red)
- **Auto-Prefix Stripping**: Common prefixes like "Mozart " are automatically removed for cleaner display

### Noise Gate

The Aalto anechoic recordings were made with uniform gain settings across all instruments, which can result in audible noise floor in quieter instruments. The built-in noise gate addresses this:

- **Automatic Enabling**: Noise gate is automatically enabled when loading Aalto profiles
- **Adjustable Threshold**: -60dB to -30dB range (default -48dB)
- **Professional Parameters**: 2ms attack, 30ms hold, 50ms release for musical gating
- **Real-Time Re-processing**: Changing threshold re-processes all tracks immediately
- **Original Buffer Preservation**: Original audio is preserved for threshold adjustments

### Reverb System

Add concert hall ambience with multiple reverb presets:

- **Small Room, Chamber, Concert Hall, Cathedral, Outdoor Amphitheater**
- **Depth-Based Mode**: Instruments farther back on stage receive more reverb, creating natural depth
- **Uniform Mode**: Equal reverb for all instruments regardless of position

### Export

Render your mix to audio files:

- **WAV Export**: Lossless 16-bit stereo audio
- **MP3 Export**: Compressed audio using lamejs encoder
- **Real-Time Progress**: Watch the render progress with cancel option

### Session Persistence

Your work is automatically saved:

- Track positions, gains, mute/solo states
- Master gain, reverb settings, mic separation
- Restored on page reload with confirmation prompt

## Anechoic Recordings

The mixer includes profiles for symphonic recordings from [Aalto University's Department of Media Technology](https://research.cs.aalto.fi/acoustics/virtual-acoustics/research/acoustic-measurement-and-analysis/85-anechoic-recordings.html):

- **Mozart** - Don Giovanni (Donna Elvira aria)
- **Beethoven** - Symphony No. 7, I mvt
- **Bruckner** - Symphony No. 8, II mvt
- **Mahler** - Symphony No. 1, IV mvt

These recordings were made in an anechoic chamber with individual musicians performing their parts while watching a conductor, allowing each instrument to be captured in isolation with no room reflections.

### Attribution

When using these recordings for academic research, please cite:

> Pätynen, J., Pulkki, V., and Lokki, T., "Anechoic recording system for symphony orchestra," *Acta Acustica united with Acustica*, vol. 94, nr. 6, pp. 856-865, 2008.

## Custom Audio

You can also load your own multi-track audio:

- **Upload ZIP**: Load a ZIP file containing audio tracks
- **Drag & Drop**: Drop individual audio files onto the drop zone
- **Supported Formats**: MP3, WAV, FLAC, OGG, AAC

## Technical Details

### Browser Requirements

- Modern browser with Web Audio API support
- Desktop recommended (Chrome, Firefox, Safari, Edge)
- WebGL not required

### Architecture

- Pure vanilla JavaScript (no frameworks)
- Web Audio API for real-time audio processing
- Canvas 2D for stage visualization
- JSZip for archive extraction
- lamejs for MP3 encoding

### Audio Processing Chain

```
Source → Gain → Panner (ITD/ILD) → Distance Filter → Reverb Send → Master
                                                          ↓
                                            Convolution Reverb → Master
```

## Development

```bash
# Clone the repository
git clone https://github.com/antorsae/web-mixer.git
cd web-mixer

# Serve locally (any static server works)
python -m http.server 8080
# or
npx serve .
```

## License

The code is provided as-is for educational and research purposes. The Aalto University recordings are free for academic research with proper attribution.

## Acknowledgments

- [Aalto University](https://research.cs.aalto.fi/acoustics/virtual-acoustics/) for the anechoic symphony recordings
- [JSZip](https://stuk.github.io/jszip/) for ZIP file handling
- [lamejs](https://github.com/zhuker/lamejs) for MP3 encoding
