import macro from 'vtk.js/Sources/macro';
import vtkOpenGLHardwareSelector from 'vtk.js/Sources/Rendering/OpenGL/HardwareSelector';
import { FieldAssociations } from 'vtk.js/Sources/Common/DataModel/DataSet/Constants';
import WMConstants from 'vtk.js/Sources/Widgets/Core/WidgetManager/Constants';
import vtkSVGRepresentation from 'vtk.js/Sources/Widgets/SVG/SVGRepresentation';

const { ViewTypes, RenderingTypes } = WMConstants;
const { vtkErrorMacro } = macro;
const { createSvgElement } = vtkSVGRepresentation;

let viewIdCount = 1;

// ----------------------------------------------------------------------------
// Helper
// ----------------------------------------------------------------------------

export function extractRenderingComponents(renderer) {
  const camera = renderer.getActiveCamera();
  const renderWindow = renderer.getRenderWindow();
  const interactor = renderWindow.getInteractor();
  const openGLRenderWindow = interactor.getView();
  return { renderer, renderWindow, interactor, openGLRenderWindow, camera };
}

// ----------------------------------------------------------------------------

function createSvgRoot(id) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute(
    'style',
    'position: absolute; top: 0; left: 0; width: 100%; height: 100%;'
  );

  const svgRoot = createSvgElement('svg');
  svgRoot.setAttribute('style', 'width: 100%; height: 100%;');
  svgRoot.setAttribute('version', '1.1');
  svgRoot.setAttribute('baseProfile', 'full');

  wrapper.appendChild(svgRoot);

  return { svgWrapper: wrapper, svgRoot };
}

// ----------------------------------------------------------------------------
// vtkWidgetManager methods
// ----------------------------------------------------------------------------

function vtkWidgetManager(publicAPI, model) {
  if (!model.viewId) {
    model.viewId = `view-${viewIdCount++}`;
  }
  model.classHierarchy.push('vtkWidgetManager');
  const propsWeakMap = new WeakMap();
  const widgetToSvgMap = new WeakMap();
  const subscriptions = [];

  // --------------------------------------------------------------------------
  // Internal variable
  // --------------------------------------------------------------------------

  model.selector = vtkOpenGLHardwareSelector.newInstance();
  model.selector.setFieldAssociation(
    FieldAssociations.FIELD_ASSOCIATION_POINTS
  );

  const svgContainers = createSvgRoot(model.viewId);
  model.svgWrapper = svgContainers.svgWrapper;
  model.svgRoot = svgContainers.svgRoot;

  // --------------------------------------------------------------------------
  // API internal
  // --------------------------------------------------------------------------

  function updateWidgetWeakMap(widget) {
    const representations = widget.getRepresentations();
    for (let i = 0; i < representations.length; i++) {
      const representation = representations[i];
      const origin = { widget, representation };
      const actors = representation.getActors();
      for (let j = 0; j < actors.length; j++) {
        const actor = actors[j];
        propsWeakMap.set(actor, origin);
      }
    }
  }

  function getViewWidget(widget) {
    return (
      widget &&
      (widget.isA('vtkAbstractWidget')
        ? widget
        : widget.getWidgetForView({ viewId: model.viewId }))
    );
  }

  // --------------------------------------------------------------------------
  // internal SVG API
  // --------------------------------------------------------------------------

  function enableSvgLayer() {
    const container = model.openGLRenderWindow.getReferenceByName('el');
    const canvas = model.openGLRenderWindow.getCanvas();
    container.insertBefore(model.svgWrapper, canvas.nextSibling);
  }

  function disableSvgLayer() {
    const container = model.openGLRenderWindow.getReferenceByName('el');
    container.removeChild(model.svgWrapper);
  }

  function addToSvgLayer(viewWidget) {
    const svgReps = viewWidget
      .getRepresentations()
      .filter((r) => r.isA('vtkSVGRepresentation'));

    if (svgReps.length) {
      // group element to hold all elements of the widget
      const widgetGroup = createSvgElement('g');

      model.svgRoot.appendChild(widgetGroup);
      widgetToSvgMap.set(viewWidget, widgetGroup);
    }
  }

  function removeFromSvgLayer(viewWidget) {
    const group = widgetToSvgMap.get(viewWidget);
    if (group) {
      model.svgRoot.removeChild(group);
      widgetToSvgMap.delete(viewWidget);
    }
  }

  function updateSvg() {
    if (model.useSvgLayer) {
      const [cwidth, cheight] = model.openGLRenderWindow.getSize();
      const ratio = window.devicePixelRatio || 1;
      const bwidth = cwidth / ratio;
      const bheight = cheight / ratio;
      const viewBox = `0 0 ${cwidth} ${cheight}`;
      model.svgRoot.setAttribute('width', bwidth);
      model.svgRoot.setAttribute('height', bheight);
      model.svgRoot.setAttribute('viewBox', viewBox);

      for (let i = 0; i < model.widgets.length; i++) {
        const widget = model.widgets[i];
        const svgReps = widget
          .getRepresentations()
          .filter((r) => r.isA('vtkSVGRepresentation'));

        if (widget.getVisibility() && svgReps.length) {
          const pendingContent = svgReps
            .filter((r) => r.getVisibility())
            .map((r) => r.render());
          Promise.all(pendingContent).then((nodes) => {
            const g = widgetToSvgMap.get(widget);
            if (g) {
              const newG = createSvgElement('g');
              for (let ni = 0; ni < nodes.length; ni++) {
                newG.appendChild(nodes[ni]);
              }
              if (g.innerHTML !== newG.innerHTML) {
                g.innerHTML = newG.innerHTML;
              }
            }
          });
        } else {
          const g = widgetToSvgMap.get(widget);
          if (g) {
            g.innerHTML = '';
          }
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // API public
  // --------------------------------------------------------------------------

  function updateWidgetForRender(w) {
    w.updateRepresentationForRender(model.renderingType);
  }

  publicAPI.enablePicking = () => {
    model.pickingEnabled = true;

    model.renderingType = RenderingTypes.PICKING_BUFFER;
    model.widgets.forEach(updateWidgetForRender);

    console.time('capture');
    const [w, h] = model.openGLRenderWindow.getSize();
    model.selector.setArea(0, 0, w, h);
    model.selector.releasePixBuffers();
    model.pickingAvailable = model.selector.captureBuffers();
    model.previousSelectedData = null;
    console.timeEnd('capture');
    publicAPI.modified();

    model.renderingType = RenderingTypes.FRONT_BUFFER;
    model.widgets.forEach(updateWidgetForRender);
  };

  publicAPI.disablePicking = () => {
    model.pickingEnabled = false;
    model.pickingAvailable = false;
  };

  publicAPI.setRenderer = (renderer) => {
    Object.assign(model, extractRenderingComponents(renderer));
    while (subscriptions.length) {
      subscriptions.pop().unsubscribe();
    }

    model.selector.attach(model.openGLRenderWindow, model.renderer);

    subscriptions.push(model.interactor.onRenderEvent(updateSvg));

    subscriptions.push(
      model.interactor.onStartAnimation(() => {
        model.pickingAvailable = false;
      })
    );
    subscriptions.push(
      model.interactor.onEndAnimation(() => {
        if (model.pickingEnabled) {
          publicAPI.enablePicking();
        }
      })
    );

    subscriptions.push(
      model.interactor.onMouseMove(({ position }) => {
        if (!model.pickingAvailable) {
          return;
        }
        publicAPI.updateSelectionFromXY(
          Math.round(position.x),
          Math.round(position.y)
        );
        const {
          requestCount,
          selectedState,
          representation,
          widget,
        } = publicAPI.getSelectedData();

        if (requestCount) {
          // Call activate only once
          return;
        }

        // Default cursor behavior
        model.openGLRenderWindow.setCursor(widget ? 'pointer' : 'default');

        if (model.widgetInFocus === widget && widget.hasFocus()) {
          widget.activateHandle({ selectedState, representation });
          // Ken FIXME
          model.interactor.render();
          model.interactor.render();
        } else {
          for (let i = 0; i < model.widgets.length; i++) {
            const w = model.widgets[i];
            if (w === widget && w.getPickable()) {
              w.activateHandle({ selectedState, representation });
              model.activeWidget = w;
            } else {
              w.deactivateAllHandles();
            }
          }
          // Ken FIXME
          model.interactor.render();
          model.interactor.render();
        }
      })
    );

    publicAPI.modified();

    if (model.pickingEnabled) {
      publicAPI.enablePicking();
    }

    if (model.useSvgLayer) {
      enableSvgLayer();
    }
  };

  publicAPI.addWidget = (widget, viewType, initialValues) => {
    if (!model.renderer) {
      vtkErrorMacro(
        'Widget manager MUST BE link to a view before registering widgets'
      );
      return null;
    }
    const { viewId, renderer } = model;
    const w = widget.getWidgetForView({
      viewId,
      renderer,
      viewType: viewType || ViewTypes.DEFAULT,
      initialValues,
    });

    if (model.widgets.indexOf(w) === -1) {
      model.widgets.push(w);
      w.setWidgetManager(publicAPI);
      updateWidgetWeakMap(w);

      // Register to renderer
      model.renderer.addActor(w);

      // register widget to svg layer
      addToSvgLayer(w);

      publicAPI.modified();
    }

    return w;
  };

  publicAPI.removeWidget = (widget) => {
    const viewWidget = getViewWidget(widget);
    const index = model.widgets.indexOf(viewWidget);
    if (index !== -1) {
      model.widgets.splice(index, 1);
      model.renderer.removeActor(viewWidget);
      model.renderer
        .getRenderWindow()
        .getInteractor()
        .render();
      publicAPI.enablePicking();

      removeFromSvgLayer(viewWidget);

      if (model.widgetInFocus === viewWidget) {
        publicAPI.releaseFocus();
      }

      // free internal model + unregister it from its parent
      viewWidget.delete();
    }
  };

  publicAPI.updateSelectionFromXY = (x, y) => {
    if (model.pickingAvailable) {
      model.selections = model.selector.generateSelection(x, y, x, y);
    }
  };

  publicAPI.updateSelectionFromMouseEvent = (event) => {
    const { pageX, pageY } = event;
    const {
      top,
      left,
      height,
    } = model.openGLRenderWindow.getCanvas().getBoundingClientRect();
    const x = pageX - left;
    const y = height - (pageY - top);
    publicAPI.updateSelectionFromXY(x, y);
  };

  publicAPI.getSelectedData = () => {
    if (!model.selections || !model.selections.length) {
      model.previousSelectedData = null;
      return {};
    }
    const { propID, compositeID, prop } = model.selections[0].getProperties();
    if (
      model.previousSelectedData &&
      model.previousSelectedData.prop === prop &&
      model.previousSelectedData.compositeID === compositeID
    ) {
      model.previousSelectedData.requestCount++;
      return model.previousSelectedData;
    }

    if (!propsWeakMap.has(prop)) {
      return {};
    }

    const { widget, representation } = propsWeakMap.get(prop);
    if (widget && representation) {
      const selectedState = representation.getSelectedState(prop, compositeID);
      model.previousSelectedData = {
        requestCount: 0,
        propID,
        compositeID,
        prop,
        widget,
        representation,
        selectedState,
      };
      return model.previousSelectedData;
    }
    model.previousSelectedData = null;
    return {};
  };

  publicAPI.grabFocus = (widget) => {
    const viewWidget = getViewWidget(widget);
    if (model.widgetInFocus && model.widgetInFocus !== viewWidget) {
      model.widgetInFocus.loseFocus();
    }
    model.widgetInFocus = viewWidget;
    if (model.widgetInFocus) {
      model.widgetInFocus.grabFocus();
    }
  };

  publicAPI.releaseFocus = () => publicAPI.grabFocus(null);

  publicAPI.setUseSvgLayer = (useSvgLayer) => {
    if (useSvgLayer !== model.useSvgLayer) {
      model.useSvgLayer = useSvgLayer;

      if (useSvgLayer) {
        if (model.renderer) {
          enableSvgLayer();
          // force a render so svg widgets can be drawn
          updateSvg();
        } else {
          disableSvgLayer();
        }
      }

      return true;
    }
    return false;
  };
}

// ----------------------------------------------------------------------------
// Object factory
// ----------------------------------------------------------------------------

const DEFAULT_VALUES = {
  viewId: null,
  widgets: [],
  renderer: [],
  viewType: ViewTypes.DEFAULT,
  pickingAvailable: false,
  pickingEnabled: true,
  selections: null,
  previousSelectedData: null,
  widgetInFocus: null,
  useSvgLayer: true,
};

// ----------------------------------------------------------------------------

export function extend(publicAPI, model, initialValues = {}) {
  Object.assign(model, DEFAULT_VALUES, initialValues);

  macro.obj(publicAPI, model);
  macro.setGet(publicAPI, model, [
    { type: 'enum', name: 'viewType', enum: ViewTypes },
  ]);
  macro.get(publicAPI, model, [
    'selections',
    'widgets',
    'viewId',
    'pickingEnabled',
    'useSvgLayer',
  ]);

  // Object specific methods
  vtkWidgetManager(publicAPI, model);
}

// ----------------------------------------------------------------------------

export const newInstance = macro.newInstance(extend, 'vtkWidgetManager');

// ----------------------------------------------------------------------------

export default { newInstance, extend };
