/* jshint -W098 */

'use strict';

var settingsConvertor = require( "viktor-nv1-settings-convertor" ),
	CONST = require( "./const" ),
	OscillatorBank = require( "./oscillator-bank" ),
	WaveformSource = require( "./waveform-source" ),
	Noise = require( "./noise" ),
	Envelope = require( "./envelope" ),
	Filter = require( "./filter" ),
	LFO = require( "./lfo" ),
	Mix = require( "./mix" );

function Voice( audioContext ) {
	var self = this,
		oscillatorBank = new OscillatorBank( audioContext, 3 ),
		waveformSource = new WaveformSource( audioContext, CONST.CUSTOM_WAVEFORMS ),
		noise = new Noise( audioContext ),
		gainEnvelope = new Envelope( audioContext, "gain", 1 ),
		gainEnvelopeNode = audioContext.createGain(),
		envelopeControlledFilter = new Filter( audioContext ),
		uiControlledFilter = new Filter( audioContext ),
		lfoControlledFilter = new Filter( audioContext ),

		envelopeFilterMix = new Mix( audioContext, uiControlledFilter.node, envelopeControlledFilter.node ),
		lfoFilterMix = new Mix( audioContext, envelopeFilterMix.output, lfoControlledFilter.node ),
		filterEnvelope = new Envelope( audioContext, "frequency", CONST.FILTER_FREQUENCY_UPPER_BOUND ),
		filterLfo = new LFO( audioContext, [ lfoControlledFilter.node ], "frequency", {
			rate: CONST.LFO_DEFAULT_RATE,
			defaultForm: CONST.LFO_DEFAULT_FORM,
			centerFrequency: CONST.LFO_DEFAULT_FREQUENCY_RANGE
		} ),
		masterVolume = audioContext.createGain();

	gainEnvelopeNode.gain.value = 0.0;
	gainEnvelope.node = gainEnvelopeNode;

	oscillatorBank.output.connect( gainEnvelope.node );
	noise.output.connect( gainEnvelope.node );

	filterEnvelope.node = envelopeControlledFilter.node;

	masterVolume.gain.value = 1.0;

	var modulationLfo = new LFO( audioContext, oscillatorBank.oscillators, "detune", {
		rate: 0,
		defaultForm: CONST.LFO_DEFAULT_FORM,
		frequencyRange: CONST.MODULATION_LFO_FREQUENCY_RANGE
	} );

	gainEnvelope.node.connect( envelopeControlledFilter.node );
	gainEnvelope.node.connect( uiControlledFilter.node );
	envelopeFilterMix.output.connect( lfoControlledFilter.node );
	lfoFilterMix.output.connect( masterVolume );

	self.audioContext = audioContext;
	self.modulationLfo = modulationLfo;
	self.oscillatorBank = oscillatorBank;
	self.waveformSource = waveformSource;
	self.noise = noise;
	self.gainEnvelope = gainEnvelope;
	self.envelopeControlledFilter = envelopeControlledFilter;
	self.uiControlledFilter = uiControlledFilter;
	self.lfoControlledFilter = lfoControlledFilter;
	self.envelopeFilterMix = envelopeFilterMix;
	self.filterLfo = filterLfo;
	self.lfoFilterMix = lfoFilterMix;
	self.filterEnvelope = filterEnvelope;
	self.outputNode = masterVolume;
	self.pressedNotes = [];
	self.sustainedNote = null;

	// non-setting properties
	self._isSustainOn = false;

	self.settings = {

		modulation: null,
		oscillator: null,
		mixer: null,
		noise: null,
		envelopes: null,
		filter: null,
		lfo: null,
		pitch: null

	};

	self._defineProps();
}

Voice.prototype = {

	loadPatch: function( patch ) {
		var self = this;

		Object.keys( patch ).forEach( function( key ) {
			self[ key + "Settings" ] = patch[ key ];
		} );
	},

	getPatch: function() {
		var self = this;

		return self.settings;
	},

	onMidiMessage: function( eventType, parsed, rawEvent ) {
		var self = this;

		if ( eventType === "notePress" ) {
			var methodName = ( parsed.isNoteOn ) ? "onNoteOn" : "onNoteOff";

			self[ methodName ]( parsed.noteFrequency, parsed.velocity );
		} else if ( eventType === "pitchBend" ) {
			self.onPitchBend( parsed.pitchBend );
		} else if ( eventType === "modulationWheel" ) {
			self.onModulationWheelTurn( parsed.modulation );
		}
	},

	onNoteOn: function( noteFrequency, velocity ) {
		var self = this,
			oscillatorBank = self.oscillatorBank,
			gainEnvelope = self.gainEnvelope,
			filterEnvelope = self.filterEnvelope,
			pressedNotes = self.pressedNotes,
			portamento = self.settings.modulation.portamento.value,
			pressedNotesCount = pressedNotes.length,
			hasANoteDown = pressedNotesCount > 0,
			pressedPosition = pressedNotes.indexOf( noteFrequency ),
			attackPeak = settingsConvertor.transposeValue(
				velocity,
				[ 0, 127 ],
				[ 0, 1 ]
			);

		if ( !hasANoteDown ) {
			self._pitchDetuneOscillatorBank( oscillatorBank, self.pitchSettings.bend.value );
		} else if ( pressedPosition === ( pressedNotesCount - 1 ) ) {
			// no need to restart sound if the same note is somehow input again
			return;
		}

		if ( pressedPosition !== -1 ) {
			pressedNotes.splice( pressedPosition, 1 );
		}

		pressedNotes.push( noteFrequency );

		oscillatorBank.note = {
			frequency: noteFrequency,
			portamento: portamento
		};

		gainEnvelope.begin( attackPeak );
		filterEnvelope.begin( attackPeak );

		if ( self._isSustainOn ) {
			self.sustainedNote = noteFrequency;
		}
	},

	onNoteOff: function( noteFrequency, velocity ) {
		var self = this,
			oscillatorBank = self.oscillatorBank,
			gainEnvelope = self.gainEnvelope,
			filterEnvelope = self.filterEnvelope,
			pressedNotes = self.pressedNotes,
			portamento = self.settings.modulation.portamento.value,
			position = pressedNotes.indexOf( noteFrequency );

		if ( position !== -1 ) {
			pressedNotes.splice( position, 1 );
		}

		if ( pressedNotes.length === 0 && !self._isSustainOn ) {
			gainEnvelope.end();
			filterEnvelope.end();
		} else if ( pressedNotes.length > 0 ) {
			noteFrequency = pressedNotes[ pressedNotes.length - 1 ];

			oscillatorBank.note = {
				frequency: noteFrequency,
				portamento: portamento
			};
		}
	},

	getCurrentNote: function() {
		var self = this,
			pressedNotes = self.pressedNotes,
			sustainedNote = self.sustainedNote;

		return pressedNotes[ pressedNotes.length - 1 ] || sustainedNote;
	},

	setSustain: function( isOn ) {
		var self = this,
			gainEnvelope = self.gainEnvelope,
			filterEnvelope = self.filterEnvelope,
			pressedNotes = self.pressedNotes;

		self._isSustainOn = isOn;

		if ( isOn ) {
			self.sustainedNote = self.getCurrentNote();
		} else {
			if ( !pressedNotes.length ) {
				gainEnvelope.end();
				filterEnvelope.end();
			}
			self.sustainedNote = null;
		}
	},

	onPitchBend: function( pitchBend ) {
		var self = this;

		self.pitchSettings = {
			bend: settingsConvertor.transposeParam( pitchBend, self.settings.pitch.bend.range )
		};
	},

	onModulationWheelTurn: function( modulation ) {
		var self = this,
			oldSettings = self.modulationSettings,
			newRate = modulation.value === 0 ?
				modulation
				:
				settingsConvertor.transposeParam( modulation, [ 3, 9 ] );

		if ( oldSettings.rate !== newRate ) {
			self.modulationSettings = {
				waveform: oldSettings.waveform,
				portamento: oldSettings.portamento,
				rate: newRate
			};
		}
	},

	_defineProps: function() {
		var self = this;

		Object.defineProperty( self, "pitchSettings", {

			get: function() {
				var self = this;

				return JSON.parse( JSON.stringify( self.settings.pitch ) );
			},

			set: function( settings ) {
				var self = this,
					oscillatorBank = self.oscillatorBank,
					oldSettings = self.settings.pitch || { bend: {} },
					hasANoteDown = self.pressedNotes.length > 0;

				if ( hasANoteDown && oldSettings.bend.value !== settings.bend.value ) {
					self._pitchDetuneOscillatorBank( oscillatorBank, settings.bend.value );
				}

				self.settings.pitch = JSON.parse( JSON.stringify( settings ) );
			}

		} );

		Object.defineProperty( self, "modulationSettings", {

			get: function() {
				// if slow - use npm clone
				return JSON.parse( JSON.stringify( self.settings.modulation ) );
			},

			set: function( settings ) {
				var waveformSource = self.waveformSource,
					oldSettings = self.settings.modulation,
					modulationLfo = self.modulationLfo;

				if ( !oldSettings || ( oldSettings.rate.value !== settings.rate.value ) ) {
					modulationLfo.rate = settings.rate.value;
				}

				if ( !oldSettings || ( oldSettings.waveform.value !== settings.waveform.value ) ) {
					var index = settings.waveform.value;

					modulationLfo.waveform = {
						defaultForm: waveformSource.defaultForms[ index ],
						customFormFFT: waveformSource.customForms[ CONST.OSC_WAVEFORM[ index ] ]
					};
				}

				self.settings.modulation = JSON.parse( JSON.stringify( settings ) );
			}

		} );

		Object.defineProperty( self, "oscillatorSettings", {

			get: function() {
				// if slow - use npm clone
				return JSON.parse( JSON.stringify( self.settings.oscillator ) );
			},

			set: function( settings ) {
				var oldSettings = self.settings.oscillator,
					oscillatorBank = self.oscillatorBank,
					waveformSource = self.waveformSource;

				oscillatorBank.forEach( function( osc, index ) {
					var propName = "osc" + ( index + 1 ),
						oldOscSettings = oldSettings && oldSettings[ propName ],
						newOscSettings = settings[ propName ];

					if ( !oldSettings || oldOscSettings.range.value !== newOscSettings.range.value ) {
						osc.octave = newOscSettings.range.value;
					}
					if ( !oldSettings || oldOscSettings.fineDetune.value !== newOscSettings.fineDetune.value ) {
						osc.cent = newOscSettings.fineDetune.value;
					}
					if ( !oldSettings || oldOscSettings.waveform.value !== newOscSettings.waveform.value ) {
						var waveform = newOscSettings.waveform.value,
							defaultForm = waveformSource.defaultForms[ waveform ];

						if ( defaultForm ) {
							osc.waveform = defaultForm;
						} else {
							osc.customWaveform = waveformSource.customForms[ CONST.OSC_WAVEFORM[ waveform ] ];
						}
					}

				} );

				self.settings.oscillator = JSON.parse( JSON.stringify( settings ) );
			}

		} );

		Object.defineProperty( self, "mixerSettings", {

			get: function() {
				// if slow - use npm clone
				return JSON.parse( JSON.stringify( self.settings.mixer ) );
			},

			set: function( settings ) {
				var oscillatorBank = self.oscillatorBank,
					oldSettings = self.settings.mixer;

				oscillatorBank.forEach( function( osc, index ) {
					var volumePropName = "volume" + ( index + 1 ),
						oldOscSettings = oldSettings && oldSettings[ volumePropName ],
						newOscSettings = settings[ volumePropName ];

					if ( !oldSettings || oldOscSettings.enabled.value !== newOscSettings.enabled.value ) {
						osc.enabled = newOscSettings.enabled.value ? true : false;
					}
					if ( !oldSettings || oldOscSettings.level.value !== newOscSettings.level.value ) {
						osc.level = newOscSettings.level.value;
					}
				} );

				self.settings.mixer = JSON.parse( JSON.stringify( settings ) );
			}

		} );

		Object.defineProperty( self, "noiseSettings", {

			get: function() {
				// if slow - use npm clone
				return JSON.parse( JSON.stringify( self.settings.noise ) );
			},

			set: function( settings ) {
				var oldSettings = self.settings.noise,
					noise = self.noise;

				if ( !oldSettings || oldSettings.enabled.value !== settings.enabled.value ) {
					noise.enabled = settings.enabled.value ? true : false;
				}
				if ( !oldSettings || oldSettings.level.value !== settings.level.value ) {
					noise.level = settings.level.value;
				}
				if ( !oldSettings || oldSettings.type.value !== settings.type.value ) {
					noise.type = settings.type.value;
				}

				self.settings.noise = JSON.parse( JSON.stringify( settings ) );
			}

		} );

		Object.defineProperty( self, "envelopesSettings", {

			get: function() {
				// if slow - use npm clone
				return JSON.parse( JSON.stringify( self.settings.envelopes ) );
			},

			set: function( settings ) {
				var oldSettings = self.settings.envelopes,
					resolve = function( oldSettings, settings, envelope ) {
						[
							"reset",
							"start",
							"attack",
							"decay",
							"sustain",
							"release"
						].forEach( function( name ) {
							var newVal = settings[ name ];

							if ( !oldSettings || oldSettings[ name ].value !== newVal.value ) {
								envelope[ name ] = newVal.value;
							}
						} );
					};

				resolve( oldSettings && oldSettings.primary, settings.primary, self.gainEnvelope );
				resolve( oldSettings && oldSettings.filter, settings.filter, self.filterEnvelope );

				self.settings.envelopes = JSON.parse( JSON.stringify( settings ) );
			}

		} );

		Object.defineProperty( self, "filterSettings", {

			get: function() {
				// if slow - use npm clone
				return JSON.parse( JSON.stringify( self.settings.filter ) );
			},

			set: function( settings ) {
				var oldSettings = self.settings.filter,
					envelopeControlledFilter = self.envelopeControlledFilter,
					uiControlledFilter = self.uiControlledFilter,
					lfoControlledFilter = self.lfoControlledFilter,
					mix = self.envelopeFilterMix;

				if ( !oldSettings || oldSettings.cutoff.value !== settings.cutoff.value ) {
					var cutoff = settings.cutoff.value;

					envelopeControlledFilter.node.frequency.value = cutoff;
					uiControlledFilter.node.frequency.value = cutoff;
				}
				if ( !oldSettings || oldSettings.emphasis.value !== settings.emphasis.value ) {
					var emphasis = settings.emphasis.value;

					envelopeControlledFilter.node.Q.value = emphasis;
					uiControlledFilter.node.Q.value = emphasis;
					lfoControlledFilter.node.Q.value = emphasis;
				}
				if ( !oldSettings || oldSettings.envAmount.value !== settings.envAmount.value ) {
					mix.amount = settings.envAmount.value;
				}

				self.settings.filter = JSON.parse( JSON.stringify( settings ) );
			}

		} );

		Object.defineProperty( self, "lfoSettings", {

			get: function() {
				// if slow - use npm clone
				return JSON.parse( JSON.stringify( self.settings.lfo ) );
			},

			set: function( settings ) {
				var waveformSource = self.waveformSource,
					oldSettings = self.settings.lfo,
					filterLfo = self.filterLfo,
					mix = self.lfoFilterMix;

				if ( !oldSettings || oldSettings.rate.value !== settings.rate.value ) {
					filterLfo.rate = settings.rate.value;
				}
				if ( !oldSettings || oldSettings.waveform.value !== settings.waveform.value ) {
					var index = settings.waveform.value;

					filterLfo.waveform = {
						defaultForm: waveformSource.defaultForms[ index ],
						customFormFFT: waveformSource.customForms[ CONST.OSC_WAVEFORM[ index ] ]
					};
				}
				if ( !oldSettings || oldSettings.amount.value !== settings.amount.value ) {
					mix.amount = settings.amount.value;
				}

				self.settings.lfo = JSON.parse( JSON.stringify( settings ) );
			}

		} );
	},

	_pitchDetuneOscillatorBank: function( oscillatorBank, value ) {
		oscillatorBank.forEach( function( oscillatorSettings ) {
			oscillatorSettings.pitchBend = value;
		} );
	}

};

module.exports = Voice;