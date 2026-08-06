"""dTools 控制器包。"""

from controller.log_controller import log_blueprint
from controller.sync_controller import sync_blueprint
from controller.token_controller import token_blueprint


BLUEPRINTS = [token_blueprint, sync_blueprint, log_blueprint]

